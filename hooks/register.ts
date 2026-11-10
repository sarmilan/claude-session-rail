import type { EngineInterface, Register } from 'claude-code'

// The controller (bin/pane.mjs) does the iTerm work; this module only decides when to call it.
// It runs through sh so the user's PATH finds `node`; the script path is passed as an argument,
// never spliced into the command string.
type Panel = 'rail' | 'desk'
const pane = ($: EngineInterface, action: 'layout' | 'open' | 'close' | 'toggle', panel: Panel | '' = '') =>
  $.process
    .run(['/bin/sh', '-c', 'exec node "$0" "$1" "$2"', `${$.plugin.root}/bin/pane.mjs`, action, panel], { timeoutMs: 20_000 })
    .then(({ stdout }) => {
      try {
        return (JSON.parse(stdout.trim()) as { state?: string }).state ?? 'error'
      } catch {
        return 'error'
      }
    })
    .catch(() => 'error')

// The person's own /start (a skill or command of theirs, not a plugin's or an MCP server's), run as if typed
// once the session is idle. The plugin is shared, so it runs only where such a command exists, and once per
// process: session.start fires again after /clear. A refusal (a host's limit, say) is ignored.
let startRan = false
const runStart = async ($: EngineInterface) => {
  if (startRan) return
  startRan = true
  try {
    if ((await $.command.list()).some(c => c.name === 'start' && c.source === 'user'))
      await $.command.run({ command: 'start', args: '' })
  } catch {}
}

const message = (state: string, panel: Panel) => {
  const name = panel === 'rail' ? 'Rail' : 'Desk'
  const messages: Record<string, string> = {
    opened: `${name} opened.`,
    'already-open': `${name} is already open.`,
    closed: `${name} closed.`,
    'already-closed': `${name} is already closed.`,
    'not-iterm': `The ${name.toLowerCase()} only opens when Claude runs in iTerm2.`,
    'no-claude': "Couldn't find this Claude session's terminal.",
  }
  return messages[state] ?? `Couldn't open or close the ${name.toLowerCase()} (is node on your PATH?).`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'rail', description: 'Open or close the session rail beside this pane' })
    await $.command.register({ name: 'desk', description: 'Open or close the desk (plan, diff and code review) beside this pane' })
    // Interactive terminal sessions only, and never block startup on iTerm. One call fills the screen, opens
    // both panels and sizes them once, so the window doesn't jump between steps. Then /start, if there is one.
    if (e.isInteractive && e.surface === 'terminal') {
      void pane($, 'layout')
      void runStart($)
    }
    return next(e)
  })

  on('command.run', { command: 'rail' }, async $ => ({ text: message(await pane($, 'toggle', 'rail'), 'rail') }))
  on('command.run', { command: 'desk' }, async $ => ({ text: message(await pane($, 'toggle', 'desk'), 'desk') }))

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
    if (e.reason !== 'clear') {
      await pane($, 'close', 'rail')
      await pane($, 'close', 'desk')
    }
    return next(e)
  })
}
