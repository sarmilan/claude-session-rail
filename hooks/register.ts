import type { EngineInterface, Register } from 'claude-code'
import { approvalRecord, briefFile, briefStatus, NO_BRIEF_BRANCHES, parseBrief } from '../bin/brief.mjs'
import * as act from './activity.ts'
import { goAhead } from './goahead.ts'
import * as compact from './compact.ts'

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
// session: the flag lives in $.state, which outlives a hot reload of this module (/reload-plugins runs
// session.start again). A refusal (a host's limit, say) is ignored.
const START_RAN = { plugin: 'session-rail', key: 'startRan' } as const
const runStart = async ($: EngineInterface) => {
  if ((await $.state.get(START_RAN)).value) return
  await $.state.set(START_RAN, true)
  // A session the rail's "+ new" started already runs /start with its problem as the first prompt.
  if (await $.env.get('SESSION_RAIL_STARTED').catch(() => undefined)) return
  try {
    if ((await $.command.list()).some(c => c.name === 'start' && c.source === 'user'))
      await $.command.run({ command: 'start', args: '' })
  } catch {}
}

// ── The session brief (bin/brief.mjs) ─────────────────────────────────────────
// On any branch but main/master, Claude writes the branch's brief before editing code, and the person
// approves it in the desk (Approve, or A) or with /approve-brief. Until then Edit, Write and NotebookEdit are refused,
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
// The repo's shared git dir and the checked-out branch ('HEAD' when detached), or null outside git.
const gitHead = async ($: EngineInterface) => {
  const cwd = await $.session.cwd()
  const git = await $.process.run(['git', '-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir', '--abbrev-ref', 'HEAD'], {
    timeoutMs: 5_000,
  })
  const [common, branch] = git.exitCode === 0 ? git.stdout.trim().split('\n') : []
  return common && branch ? { cwd, common, branch } : null
}
const readBrief = async ($: EngineInterface): Promise<Brief | null> => {
  const head = await gitHead($)
  if (!head || NO_BRIEF_BRANCHES.includes(head.branch)) return null
  const { common, branch } = head
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

While you work, keep the brief current: if the problem, the solution or the outline changes, update the brief right away.

Work through the chunks in order. When you finish one:
1. Review it yourself against its outline and the brief's Problem and Solution: is it complete, is it the simplest way, and does it work (run the tests and checks)? Fix what falls short first. If the plan itself has to change, update the brief and say so.
2. When it's satisfactory, add two lines under the chunk's outline:
Done: <a short happy-path summary: what changed and how it works end to end>
Files: <comma-separated paths relative to the repo root>
3. Commit the chunk on its own: one commit per chunk, its message naming the chunk.
4. Push the branch. After the first chunk's commit, also open a pull request for the branch, titled after the brief, with its Problem and Solution as the description; later pushes update it.
5. Move straight on to the next chunk without waiting for the person, unless something needs their decision.

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
const gate = async ($: EngineInterface, tool: string, file: string) => {
  const b = await readBrief($)
  if (!b) return null
  const reason =
    file === b.approvedPath ? 'session-rail: only the person approves the brief, in the desk or with /approve-brief.'
    : file.startsWith(b.dir) || b.approval?.approvedAt ? null
    : gateReason(b)
  if (reason) record($, a => act.refused(a, tool, file, Date.now()))
  return reason
}

// /approve-brief: the same as Approve in the desk, for when the desk isn't open. It approves a complete brief
// (again, after it changed) and otherwise says why it can't. (Claude Code ships a /brief of its own.)
const approveCommand = async ($: EngineInterface) => {
  const b = await readBrief($)
  if (!b) return 'This branch has no session brief (main, master and a detached HEAD go without one).'
  if (b.text === null) return `No brief for ${b.branch} yet. Claude writes it at ${b.path} before editing code.`
  const brief = parseBrief(b.text)
  if (brief.missing.length) return `Can't approve yet: the brief is missing ${brief.missing.join(', ')}.\n${b.path}`
  if (briefStatus(brief, b.approval) === 'approved') return `The brief for ${b.branch} is already approved.`
  await $.fs.write(b.approvedPath, approvalRecord(brief, Date.now()))
  return `Brief approved. Claude can edit code on ${b.branch} and will be told to go ahead in a moment.`
}

// ── The go-ahead (goahead.ts) ─────────────────────────────────────────────────
// Approving the brief (the desk's button or A, or /approve-brief) only writes the approval file, so the hooks
// look for a new approval every 2 seconds and tell Claude to start (or, after a change, to carry on). One
// sender for every way to approve; $.prompt.submit waits until Claude is idle and never types over the person.
const APPROVAL_SEEN = { plugin: 'session-rail', key: 'approvalSeen' } as const
const checkApproval = async ($: EngineInterface) => {
  const b = await readBrief($)
  if (!b) return
  const now = { branch: b.branch, approvedAt: typeof b.approval?.approvedAt === 'number' ? b.approval.approvedAt : null }
  const prev = (await $.state.get(APPROVAL_SEEN)).value ?? null
  if (prev?.branch === now.branch && prev.approvedAt === now.approvedAt) return
  await $.state.set(APPROVAL_SEEN, now)
  const text = goAhead(prev, now, b.text ? parseBrief(b.text).chunks[0]?.name : undefined)
  if (text) await $.prompt.submit({ text })
}

// ── Auto-compaction (compact.ts) ──────────────────────────────────────────────
// When the session leaves a branch, it's remembered; once Claude's turn has ended, the session is compacted
// if that branch's brief has a finished chunk and its tip is in the default branch. A turn still running
// (compact rejects) leaves it for the next poll, up to 3 tries, since each try is a model call; an unmerged or
// unfinished branch, or the setting off, drops it.
const BRANCH_SEEN = { plugin: 'session-rail', key: 'branchSeen' } as const
const COMPACT_AFTER = { plugin: 'session-rail', key: 'compactAfter' } as const
const merged = async ($: EngineInterface, cwd: string, branch: string) => {
  for (const base of ['origin/HEAD', 'main', 'master']) {
    const r = await $.process.run(['git', '-C', cwd, 'merge-base', '--is-ancestor', branch, base], { timeoutMs: 5_000 }).catch(() => null)
    if (r?.exitCode === 0) return true
  }
  return false
}
const autoCompactOn = async ($: EngineInterface) => {
  try {
    const home = await $.env.get('HOME')
    return (JSON.parse(String(await $.fs.read(`${home}/.claude/session-rail/settings.json`))) as { autoCompact?: boolean }).autoCompact !== false
  } catch {
    return true
  }
}
let compactTries = 0
const checkBoundary = async ($: EngineInterface) => {
  const head = await gitHead($)
  if (!head) return
  const prev = (await $.state.get(BRANCH_SEEN)).value ?? null
  if (prev !== head.branch) {
    await $.state.set(BRANCH_SEEN, head.branch)
    const left = compact.leftBranch(prev, head.branch)
    if (left) await $.state.set(COMPACT_AFTER, left)
  }
  const after = (await $.state.get(COMPACT_AFTER)).value ?? null
  if (!after || activity.claude.state !== 'waiting') return
  const brief = await $.fs.read(briefFile(head.common, after, 'md')).then(t => String(t), () => null)
  const drop = () => {
    compactTries = 0
    return $.state.set(COMPACT_AFTER, null)
  }
  if (!(await autoCompactOn($)) || !compact.finished(brief) || !(await merged($, head.cwd, after))) return drop()
  try {
    const r = await $.session.compact({ instructions: compact.instructions(after, head.branch) })
    await drop()
    if (!('skip' in r)) record($, a => act.compacted(a, after, Date.now()))
  } catch {
    if (++compactTries >= 3) await drop() // else a turn is running: try again on the next poll
  }
}

// One poll for both, never overlapping (a compaction takes a while): the go-ahead, then the boundary.
let poller: { cancel: () => void } | null = null
let pollBusy = false
const pollOnce = async ($: EngineInterface) => {
  if (pollBusy) return
  pollBusy = true
  await checkApproval($).catch(() => {})
  await checkBoundary($).catch(() => {})
  pollBusy = false
}
const watch = ($: EngineInterface) => {
  poller?.cancel()
  void pollOnce($)
  poller = $.clock.every(2_000, () => void pollOnce($))
}

// ── Live activity for the rail's Now section (activity.ts) ────────────────────
// Kept in memory (a reload starts it afresh) and written whole on each change. Writes are chained and
// coalesced: a burst of events while one write is in flight becomes one more write, never interleaved ones.
let activity = act.fresh(Date.now())
let callSeq = 0
let saving: Promise<void> = Promise.resolve()
let dirty = false
const saveActivity = ($: EngineInterface) => {
  dirty = true
  saving = saving.then(async () => {
    if (!dirty) return
    dirty = false
    try {
      const [home, id] = await Promise.all([$.env.get('HOME'), $.session.id()])
      if (home && id) await $.fs.write(`${home}/.claude/session-rail/activity/${id}.json`, JSON.stringify(activity))
    } catch {}
  })
}
const record = ($: EngineInterface, change: (a: act.Activity) => act.Activity) => {
  activity = change(activity)
  saveActivity($)
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

const COMMANDS = [
  { name: 'rail', description: 'Open or close the session rail beside this pane' },
  { name: 'desk', description: 'Open or close the desk (plan, diff and code review) beside this pane' },
  { name: 'approve-brief', description: "Approve this branch's session brief, so Claude can edit code" },
]

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Each on its own: a name the engine refuses (one Claude Code has since taken) must not stop the panels opening.
    for (const command of COMMANDS) await $.command.register(command).catch(() => {})
    // Interactive terminal sessions only, and never block startup on iTerm. One call fills the screen, opens
    // both panels and sizes them once, so the window doesn't jump between steps. Then /start, if there is one.
    if (e.isInteractive && e.surface === 'terminal') {
      void pane($, 'layout')
      void runStart($)
    }
    if (e.isInteractive) watch($)
    return next(e)
  })

  on('command.run', { command: 'rail' }, async $ => ({ text: message(await pane($, 'toggle', 'rail'), 'rail') }))
  on('command.run', { command: 'desk' }, async $ => ({ text: message(await pane($, 'toggle', 'desk'), 'desk') }))
  on('command.run', { command: 'approve-brief' }, async $ => ({ text: await approveCommand($) }))

  // Tell Claude about the brief on any branch that has one. The text names the branch and the path only,
  // so it stays the same for the whole branch and doesn't break the prompt cache.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const b = await readBrief($).catch(() => null)
    return b ? { sections: [...composed.sections, { id: 'session-rail-brief', text: briefInstructions(b), scope: 'session' as const }] } : composed
  })

  // Live activity: the main loop's turns, and every tool call (a subagent's carries its agentId).
  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      const model = await $.session.model().catch(() => undefined)
      record($, a => act.turnStarted(a, model, Date.now()))
    }
    return next(e)
  })
  on('turn.complete', ($, e, next) => {
    if (!e.agentId) record($, a => act.turnEnded(a, Date.now()))
    return next(e)
  })
  on('turn.abort', ($, e, next) => {
    if (!(e as { agentId?: string }).agentId) record($, a => act.turnEnded(a, Date.now())) // its type names no agentId yet
    return next(e)
  })
  on('tool.call', async ($, e, next) => {
    const id = String(++callSeq)
    const arg = act.summarise(e.tool, e as unknown as Record<string, unknown>, await $.session.cwd().catch(() => ''))
    record($, a => act.callStarted(a, { id, tool: e.tool, arg, since: Date.now(), ...(e.agentId ? { agent: e.agentId } : {}) }))
    let ok = false
    try {
      const r = await next(e)
      ok = r.deny === undefined && r.isError !== true
      return r
    } finally {
      record($, a => act.callFinished(a, id, ok, Date.now()))
    }
  })

  // The gate: code edits wait for an approved brief. A failure in the gate lets the edit through.
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const deny = await gate($, 'Edit', e.file_path)
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const deny = await gate($, 'Write', e.file_path)
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const deny = await gate($, 'NotebookEdit', e.notebook_path)
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
