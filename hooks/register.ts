import type { EngineInterface, Register } from 'claude-code'

// The controller (bin/pane.mjs) does the iTerm work; this module only decides when to call it.
// It runs through sh so the user's PATH finds `node`; the script path is passed as an argument,
// never spliced into the command string.
const pane = ($: EngineInterface, action: 'open' | 'close' | 'toggle') =>
  $.process
    .run(['/bin/sh', '-c', 'exec node "$0" "$1"', `${$.plugin.root}/bin/pane.mjs`, action], { timeoutMs: 15_000 })
    .then(({ stdout }) => {
      try {
        return (JSON.parse(stdout.trim()) as { state?: string }).state ?? 'error'
      } catch {
        return 'error'
      }
    })
    .catch(() => 'error')

const MESSAGES: Record<string, string> = {
  opened: 'Rail opened.',
  'already-open': 'Rail is already open.',
  closed: 'Rail closed.',
  'already-closed': 'Rail is already closed.',
  'not-iterm': 'The rail only opens when Claude runs in iTerm2.',
  'no-claude': "Couldn't find this Claude session's terminal.",
  error: "Couldn't open or close the rail (is node on your PATH?).",
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'rail', description: 'Open or close the session rail beside this pane' })
    // Interactive terminal sessions only, and never block startup on iTerm.
    if (e.isInteractive && e.surface === 'terminal') void pane($, 'open')
    return next(e)
  })

  on('command.run', { command: 'rail' }, async $ => ({
    text: MESSAGES[await pane($, 'toggle')] ?? MESSAGES.error,
  }))

  // Rate limits are per account, so one file serves every rail; the newest reading wins.
  // sh resolves $HOME (no Node APIs here) and the mv keeps a rail from reading half a file.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits'))
      void $.process
        .run([
          '/bin/sh',
          '-c',
          'd="$HOME/.claude/session-rail"; mkdir -p "$d" && printf %s "$0" > "$d/usage.json.tmp" && mv "$d/usage.json.tmp" "$d/usage.json"',
          JSON.stringify({ rateLimits: e.rateLimits }),
        ])
        .catch(() => {})
    return next(e)
  })

  // /clear keeps the same process (the rail follows it by pid), so only close on a real end.
  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear') await pane($, 'close')
    return next(e)
  })
}
