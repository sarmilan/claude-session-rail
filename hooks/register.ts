import type { EngineInterface, Register } from 'claude-code'
import { approvalRecord, briefFile, briefStatus, NO_BRIEF_BRANCHES, parseBrief } from '../bin/brief.mjs'

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

// ── The session brief (bin/brief.mjs) ─────────────────────────────────────────
// On any branch but main/master, Claude writes the branch's brief before editing code, and the person
// approves it with /brief approve (or in the desk). Until then Edit, Write and NotebookEdit are refused,
// except on the brief itself. Once approved, edits stay allowed even if the brief changes later: the desk
// shows "changed since approval" and a review of the change. Bash isn't gated.
type Brief = {
  branch: string
  path: string
  approvedPath: string
  dir: string
  text: string | null
  approval: { approvedAt?: number; core?: string } | null
}
const readBrief = async ($: EngineInterface): Promise<Brief | null> => {
  const cwd = await $.session.cwd()
  const git = await $.process.run(['git', '-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir', '--abbrev-ref', 'HEAD'], {
    timeoutMs: 5_000,
  })
  const [common, branch] = git.exitCode === 0 ? git.stdout.trim().split('\n') : []
  if (!common || !branch || NO_BRIEF_BRANCHES.includes(branch)) return null
  const path = briefFile(common, branch, 'md')
  const approvedPath = briefFile(common, branch, 'approved.json')
  const read = (p: string) => $.fs.read(p).then(t => String(t), () => null)
  const [text, approved] = await Promise.all([read(path), read(approvedPath)])
  let approval = null
  try {
    approval = approved ? JSON.parse(approved) : null
  } catch {}
  return { branch, path, approvedPath, dir: `${common}/session-rail/`, text, approval }
}

const BRIEF_SHAPE = `# <title>
## Problem
Currently <A>; we need <B> to solve <A>.
## Solution
As a <who>, I should be able to <what> so I can <why>.
## Design
The design and UI/UX decisions.
## Mockups
ASCII mockups, in a code block.
## Engineering
### Chunk 1: <name>
A rough outline of the changes for this part of the goal.
### Chunk 2: <name>
…`

const briefInstructions = (b: Brief) => `Session brief (session-rail plugin). This branch, ${b.branch}, keeps a session brief at ${b.path}. It's a local file inside .git, never committed. It's what the session sets out to do and what the work is checked against at the end.

Work the brief out with the person before editing any code. Don't wait to be asked: as soon as the discussion makes the problem and the solution clear, tell the person it's scoped out and write the brief, then summarise it for them in a few lines and say it's in the desk's Plan tab. Keep filling it in as the discussion goes on (design, mockups, engineering chunks). Write it in this shape:

${BRIEF_SHAPE}

Keep the solution and the outline the simplest way to reach the goal. Edit, Write and NotebookEdit calls on any other file are refused until the brief has a problem, a solution and at least one chunk, and the person has approved it. When it's complete, ask them to review it and press Approve in the desk's Plan tab. Never approve it yourself or write its approval file.

While you work, keep the brief current: if the problem, the solution or the outline changes, update the brief right away. When you finish a chunk, add two lines under its outline:
Done: <one sentence: what changed and why>
Files: <comma-separated paths relative to the repo root>

At the end of the session, check the work against the brief's Problem and Solution.`

const gateReason = (b: Brief) => {
  const where = `The brief for ${b.branch} is at ${b.path}.`
  if (b.text === null) return `session-rail: code edits wait for the session brief. Write it first, in the shape the system prompt gives. ${where}`
  const brief = parseBrief(b.text)
  if (brief.missing.length) return `session-rail: code edits wait for the session brief, which is missing: ${brief.missing.join(', ')}. ${where}`
  return `session-rail: the session brief is complete but not approved yet. Ask the person to review it in the desk's Plan tab and press Approve there, then carry on. ${where}`
}

// Why an edit of `file` is refused, or null to let it through. The brief itself (anything under
// .git/session-rail/) can always be written, except its approval file.
const gate = async ($: EngineInterface, file: string) => {
  const b = await readBrief($)
  if (!b) return null
  if (file === b.approvedPath) return 'session-rail: only the person approves the brief, with /brief approve.'
  if (file.startsWith(b.dir) || b.approval?.approvedAt) return null
  return gateReason(b)
}

const briefCommand = async ($: EngineInterface, args: string) => {
  const b = await readBrief($)
  if (!b) return 'This branch has no session brief (main, master and a detached HEAD go without one).'
  if (b.text === null) return `No brief for ${b.branch} yet. Claude writes it at ${b.path} before editing code.`
  const brief = parseBrief(b.text)
  if (args.trim() === 'approve') {
    if (brief.missing.length) return `Can't approve yet: the brief is missing ${brief.missing.join(', ')}.`
    await $.fs.write(b.approvedPath, approvalRecord(brief, Date.now()))
    return `Brief approved. Claude can edit code on ${b.branch}.`
  }
  const status = briefStatus(brief, b.approval)
  const line = {
    draft: `draft, missing: ${brief.missing.join(', ')}`,
    ready: "ready for your approval: press Approve in the desk's Plan tab, or /brief approve",
    approved: 'approved',
    changed: 'approved, and changed since (edits stay allowed)',
  }[status]
  return `Brief for ${b.branch}: ${line}\n${b.path}`
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
    await $.command.register({ name: 'brief', description: "Show this branch's session brief status, or approve it: /brief approve" })
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
  on('command.run', { command: 'brief' }, async ($, e) => ({ text: await briefCommand($, e.args) }))

  // Tell Claude about the brief on any branch that has one. The text names the branch and the path only,
  // so it stays the same for the whole branch and doesn't break the prompt cache.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const b = await readBrief($).catch(() => null)
    return b ? { sections: [...composed.sections, { id: 'session-rail-brief', text: briefInstructions(b), scope: 'session' as const }] } : composed
  })

  // The gate: code edits wait for an approved brief. A failure in the gate lets the edit through.
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const deny = await gate($, e.file_path)
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const deny = await gate($, e.file_path)
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const deny = await gate($, e.notebook_path)
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => next(e))

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
