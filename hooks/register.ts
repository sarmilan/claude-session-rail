import type { EngineInterface, Register } from 'claude-code'
import { approvalRecord, briefFile, briefStatus, NO_BRIEF_BRANCHES, parseBrief } from '../bin/brief.mjs'
import * as act from './activity.ts'
import { goAhead } from './goahead.ts'
import * as compact from './compact.ts'
import { pickColour, pickName } from '../bin/names.mjs'
import { codeRun, gateReason as reviewWait, keptRuns, mergesPr, reportFromText, reviewsFile } from '../bin/cadence.mjs'

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
  common: string
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
  return { branch, common, path, approvedPath, dir: `${common}/session-rail/`, text, approval }
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

Keep the solution and the outline the simplest way to reach the goal. Edit, Write and NotebookEdit calls on any other file are refused until the brief has a problem, a solution and at least one chunk, and the person has approved it. When it's complete, call the review_approach tool on it (a plan review: the cheapest time to change course), work its findings into the brief, then ask them to review it and press Approve in the desk's Plan tab. Never approve it yourself or write its approval file.

While you work, keep the brief current: if the problem, the solution or the outline changes, update the brief right away.

Work through the chunks in order. When you finish one:
1. Review it yourself against its outline and the brief's Problem and Solution: is it complete, is it the simplest way, and does it work (run the tests and checks)? Fix what falls short first. If the plan itself has to change, update the brief and say so.
2. When it's satisfactory, add two lines under the chunk's outline:
Done: <a short happy-path summary: what changed and how it works end to end>
Files: <comma-separated paths relative to the repo root>
3. Call the review_approach tool. Apply each finding and update the brief to match; if one shouldn't be applied, pass your reason in its notes. Call it once more to check them, at most two rounds; if something is still open after that, say so to the person.
4. Run what the chunk built once for real (the command, the UI frame, the hook in a live session), not only its tests, and fix what that shows.
5. Commit the chunk on its own: one commit per chunk, its message naming the chunk.
6. Push the branch. After the first chunk's commit, also open a pull request for the branch, titled after the brief, with its Problem and Solution as the description and a Progress checklist of the chunks; tick each chunk as it lands, noting its approach review (for example "review: 2 findings, applied"). Later pushes update it.
7. Move straight on to the next chunk without waiting for the person, unless something needs their decision.

Before merging, which waits for the person to say so: run /code-review --fix over the whole branch (against the default branch) and commit and push its fixes. Then call review_approach with final: true: it also checks what the code review's fixer did (that fixes landed, and whether each skip or "no change" is sound). Apply what it finds, commit and push, and call it with final: true once more to check them: at most two rounds. If something is still open after that, list it in the PR and ask the person instead of looping. The plugin refuses gh pr merge until the code review has run since the last chunk's review, the final approach review has run after it on the last commit with nothing uncommitted, and nothing is open.

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

// ── The review cadence (bin/cadence.mjs) ──────────────────────────────────────
// On a branch with an approved brief, `gh pr merge` waits for a code review of the whole branch and a final
// approach review, both after the last commit on a clean tree, with nothing open. Commits aren't gated. The
// code review is recorded from /code-review's final JSON block. A failure in the gate lets the command through.
type Run = Record<string, unknown> & { findings: unknown[] }
const readRuns = async ($: EngineInterface, path: string): Promise<Run[]> => {
  try {
    const runs = (JSON.parse(String(await $.fs.read(path))) as { runs?: unknown }).runs
    return Array.isArray(runs) ? (runs as Run[]).filter(r => r && Array.isArray(r.findings)) : []
  } catch {
    return []
  }
}
// The commit HEAD points at, or null.
const headCommit = async ($: EngineInterface, cwd: string) => {
  const rev = await $.process.run(['git', '-C', cwd, 'rev-parse', 'HEAD'], { timeoutMs: 5_000 })
  return rev.exitCode === 0 ? rev.stdout.trim() : null
}
// Whether the tree has uncommitted changes (true when git can't say).
const isDirty = async ($: EngineInterface, cwd: string) => {
  const st = await $.process.run(['git', '-C', cwd, 'status', '--porcelain'], { timeoutMs: 10_000 })
  return st.exitCode !== 0 || st.stdout.trim() !== ''
}
// The branch's review record, beside its brief.
const runsPath = (b: Brief) => reviewsFile(b.common, b.branch)
// Without the tool (the engine refused it) Claude can't satisfy the gate, so it stands aside.
let reviewToolReady = false
const reviewGate = async ($: EngineInterface, command: string) => {
  if (!mergesPr(command) || !reviewToolReady) return null
  const b = await readBrief($)
  if (!b?.approval?.approvedAt) return null
  const [commit, runs] = await Promise.all([headCommit($, await $.session.cwd()), readRuns($, runsPath(b))])
  return commit ? reviewWait(runs, { head: commit }) : null
}
const recordCodeReview = async ($: EngineInterface, report: unknown) => {
  const b = await readBrief($)
  if (!b) return
  const cwd = await $.session.cwd()
  const [commit, dirty, earlier] = await Promise.all([headCommit($, cwd), isDirty($, cwd), readRuns($, runsPath(b))])
  const runs = [codeRun(report, { head: commit, dirty, at: Date.now() }), ...earlier]
  // Written beside it and renamed over it, so the desk never reads half a file.
  const tmp = `${runsPath(b)}.${Date.now()}.tmp`
  await $.fs.write(tmp, JSON.stringify({ runs: keptRuns(runs) }, null, 1))
  await $.process.run(['mv', '-f', tmp, runsPath(b)], { timeoutMs: 5_000 })
}

// What a run's prompt is told: end with a findings block that carries the run's token, so the plugin knows
// the answer is this run's report however it ran (forked or inline, in the main loop or a subagent).
const reportOutcomes = (token: string) =>
  `session-rail: this branch's merge waits for this review. End your final message with a \`\`\`json block holding {"run": "${token}", "findings": [...]}: the findings after --fix, each given an "outcome": "fixed", "skipped" or "no_change_needed" (an empty list when there were none).`

// A /code-review run on a gated branch, armed when the Skill tool runs it or the person types it (a skill
// merely preloaded into an agent arms nothing). It gets a token, its first prompt asks for the token in the
// final findings block, and the answer that carries it is the report, wherever it comes from. A new run
// replaces an unfinished one. With nothing armed, a hand-off costs one state read.
const CODE_REVIEW = { plugin: 'session-rail', key: 'codeReview' } as const
const isCodeReview = (skill: unknown) => typeof skill === 'string' && (skill === 'code-review' || skill.endsWith(':code-review'))
const armCodeReview = async ($: EngineInterface) => {
  const b = reviewToolReady ? await readBrief($).catch(() => null) : null
  // Without the tool the gate stands aside, and off a gated branch nothing waits: a run left armed earlier ends here.
  if (!b?.approval?.approvedAt) return $.state.set(CODE_REVIEW, null)
  await $.state.set(CODE_REVIEW, { token: `cr-${Date.now().toString(36)}`, prompted: false })
}
const finishCodeReview = async ($: EngineInterface, answer: string) => {
  const run = (await $.state.get(CODE_REVIEW)).value
  if (!run) return
  const report = reportFromText(answer)
  // The report after --fix gives findings an outcome (one left without stays open); an empty list is clean.
  if (report?.run !== run.token) return
  if (report.findings.length && !report.findings.some((f: { outcome?: unknown }) => typeof f.outcome === 'string')) return
  await $.state.set(CODE_REVIEW, null)
  await recordCodeReview($, report)
}

// review_approach: the tool Claude calls before each commit (and with final before a merge). It runs the
// desk's reviewer through its CLI, which saves the run in the branch's record and prints what Claude reads.
const REVIEW_TOOL = {
  name: 'review_approach',
  description:
    "Runs the session-rail approach review: a staff engineer checks this branch's brief, its finished chunks and the changed files for a simpler, cheaper or more complete way to the goal, checks whether the earlier findings were applied, and checks what /code-review's fixer did about its findings. Call it on the brief once it's complete (before asking for approval), after each chunk's Done line, and once more to check applied findings (at most two rounds); call it with final: true before merging, after /code-review --fix over the whole branch and its fixes are committed. Takes under a minute.",
  inputSchema: {
    type: 'object',
    properties: {
      final: { type: 'boolean', description: 'The final review of the whole branch before merging' },
      notes: {
        type: 'array',
        description: "Your reply to an earlier finding you chose not to apply: its id and why. The review decides whether to accept it.",
        items: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string' } }, required: ['id', 'note'] },
      },
    },
  },
  isDeferred: false,
}
const runReview = async ($: EngineInterface, input: { final?: unknown; notes?: unknown }) => {
  const args = ['--run', ...(input.final === true ? ['--final'] : []), ...(Array.isArray(input.notes) ? ['--notes', JSON.stringify(input.notes)] : [])]
  try {
    const r = await $.process.run(['/bin/sh', '-c', 'exec node "$@"', 'sh', `${$.plugin.root}/bin/reviewer.mjs`, ...args], {
      cwd: await $.session.cwd(),
      timeoutMs: 600_000,
    })
    return r.stdout.trim() || `The approach review printed nothing${r.stderr.trim() ? `: ${r.stderr.trim().split('\n').pop()}` : ''}.`
  } catch (err) {
    return `The approach review didn't finish: ${err instanceof Error ? err.message : String(err)}`
  }
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
// Names picked for spawns still starting, with their colours (agent.spawn).
const naming = new Map<string, number>()
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
    reviewToolReady = await $.tool.register(REVIEW_TOOL).then(() => true, () => false)
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

  // Every new subagent gets a name and colour (bin/names.mjs), and its task reads "Name: description", which is
  // what the task list and its notification show. A resume keeps the name it had; a workflow agent's description
  // can't be rewritten, so it's named on the rail only. Names and colours are held from the pick to the record,
  // so spawns in parallel never share one.
  on('agent.spawn', async ($, e, next) => {
    const known = e.resume && activity.agents?.[e.resume.agentId]
    if (known) {
      const r = await next(e)
      record($, a => act.agentStarted(a, e.resume!.agentId, { ...known, since: Date.now(), endedAt: undefined }))
      return r
    }
    const agents = Object.values(activity.agents ?? {})
    const name = pickName([...agents.map(g => g.name), ...naming.keys()])
    const colour = pickColour([...agents.filter(g => !g.endedAt).map(g => g.colour), ...naming.values()])
    const what = e.description.trim()
    naming.set(name, colour)
    try {
      const r = await next(e.workflow || e.resume ? e : { ...e, description: what ? `${name}: ${what}` : name })
      if (!r.deny && r.agentId) record($, a => act.agentStarted(a, r.agentId!, { name, colour, what, since: Date.now(), background: e.background === true }))
      return r
    } finally {
      naming.delete(name)
    }
  })

  // Live activity: the main loop's turns, and every tool call (a subagent's carries its agentId). A subagent
  // ends at its own turn's end, and a teammate woken for another turn is live again.
  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      const model = await $.session.model().catch(() => undefined)
      record($, a => act.turnStarted(a, model, Date.now()))
    } else if (activity.agents?.[e.agentId]?.endedAt) record($, a => act.agentStarted(a, e.agentId!, { ...a.agents![e.agentId!], endedAt: undefined }))
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) record($, a => act.turnEnded(a, Date.now()))
    else record($, a => act.agentEnded(a, e.agentId!, Date.now()))
    if (!e.isAborted) await finishCodeReview($, e.answer).catch(() => {})
    return next(e)
  })
  on('turn.abort', ($, e, next) => {
    const agentId = (e as { agentId?: string }).agentId // its type names no agentId yet
    record($, a => (agentId ? act.agentEnded(a, agentId, Date.now()) : act.turnEnded(a, Date.now())))
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

  // The review cadence: merges wait for the reviews, and /code-review's report is recorded.
  on('tool.call', { tool: 'mcp__session-rail__review_approach' }, async ($, e) => ({ result: await runReview($, e as never) }) as never)
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const deny = await reviewGate($, e.command)
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => next(e))
  // /code-review's output contract is a JSON block, not ReportFindings: on a gated branch an armed run's prompt
  // asks for outcomes and its token in that block, and the answer carrying the token is recorded (turn.complete).
  // The Skill tool running code-review arms the run.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    if (isCodeReview(e.skill)) await armCodeReview($).catch(() => {})
    return next(e)
  })
  // …and so does the person typing /code-review (the main loop is the caller).
  on('command.run', async ($, e, next) => {
    if (isCodeReview(e.command)) await armCodeReview($).catch(() => {})
    return next(e)
  })
  // The run's own prompt (the first after arming) asks for outcomes in its final block; a skill merely
  // preloaded into an agent isn't changed.
  on('skill.prompt', async ($, e, next) => {
    const r = await next(e)
    if (!isCodeReview(e.skill)) return r
    const run = (await $.state.get(CODE_REVIEW).catch(() => ({ value: null }))).value
    if (!run || run.prompted) return r
    await $.state.set(CODE_REVIEW, { ...run, prompted: true })
    return { text: `${r.text}\n\n${reportOutcomes(run.token)}` }
  })

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
