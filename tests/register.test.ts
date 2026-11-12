import { expect, test } from 'claude-code/testing'
import { goAhead } from '../hooks/goahead.ts'
import * as compact from '../hooks/compact.ts'
import * as cadence from '../bin/cadence.mjs'

// Each hook below stands for the engine. process.run records the controller action asked for.
const harness = (on: Parameters<Parameters<typeof test>[1]>[1], reply = 'opened', commands = ['help']) => {
  const calls: string[] = []
  on('command.register', () => ({ value: { command: 'rail' } }))
  on('command.list', () => ({ value: commands.map(name => ({ name, description: '', source: 'user' as const })) }))
  on('process.run', (_, e) => {
    const argv = e.argv ?? []
    // argv: sh -c 'exec node "$0" "$1" "$2"' <plugin root>/bin/pane.mjs <action> <panel>
    calls.push(`${String(argv[3] ?? '').endsWith('/bin/pane.mjs') ? 'pane.mjs' : '?'} ${String(argv[4] ?? '')} ${String(argv[5] ?? '')}`.trim())
    return { value: { exitCode: 0, stdout: `{"state":"${reply}"}\n`, stderr: '' } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('command.run', (_, e) => {
    calls.push(`/${e.command}`)
    return {}
  })
  return calls
}

test('a terminal session lays out both panels in one call on start', async ($, on) => {
  const calls = harness(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await new Promise(r => setTimeout(r, 10))
  expect(calls).toEqual(['pane.mjs layout'])
})

test('a terminal session runs /start on start when there is one', async ($, on) => {
  const calls = harness(on, 'opened', ['help', 'start'])
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await new Promise(r => setTimeout(r, 10))
  expect(calls).toContain('/start')
})

test('a non-interactive or desktop session does not open it', async ($, on) => {
  const calls = harness(on)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await new Promise(r => setTimeout(r, 10))
  expect(calls.length).toBe(0)
})

test('/rail toggles and reports the result', async ($, on) => {
  const calls = harness(on, 'closed')
  const result = await $.command.run({ command: 'rail', args: '' })
  expect(calls).toEqual(['pane.mjs toggle rail'])
  expect(result.text).toBe('Rail closed.')
})

test('/desk toggles the desk and reports the result', async ($, on) => {
  const calls = harness(on, 'opened')
  const result = await $.command.run({ command: 'desk', args: '' })
  expect(calls).toEqual(['pane.mjs toggle desk'])
  expect(result.text).toBe('Desk opened.')
})

test('outside iTerm2 the message names the panel', async ($, on) => {
  harness(on, 'not-iterm')
  const result = await $.command.run({ command: 'desk', args: '' })
  expect(result.text).toBe('The desk only opens when Claude runs in iTerm2.')
})

test('session end closes both panels, but /clear keeps them', async ($, on) => {
  const calls = harness(on, 'closed')
  await $.session.end({ reason: 'clear', sessionId: 'a' })
  expect(calls.length).toBe(0)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'a' })
  expect(calls).toEqual(['pane.mjs close rail', 'pane.mjs close desk'])
})

// ── The session brief ─────────────────────────────────────────────────────────
// Stands for git (the branch), the file system (the brief and its approval) and the edit tools beneath the gate.
const COMPLETE = `# T
## Problem
Currently it's A; we need B to solve A.
## Solution
As a dev, I should be able to Y so I can Z.
## Engineering
### Chunk 1: first
Do the first thing.
`
const briefHarness = (on: Parameters<Parameters<typeof test>[1]>[1], { branch = 'feature/x', brief = null as string | null } = {}) => {
  const base = `/repo/.git/session-rail/briefs/${encodeURIComponent(branch)}`
  const files: Record<string, string> = brief === null ? {} : { [`${base}.md`]: brief }
  const edits: string[] = []
  on('command.register', () => ({ value: { command: 'approve-brief' } }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('process.run', (_, e) => {
    const out = e.argv[0] === 'git' ? `/repo/.git\n${branch}\n` : '{"state":"opened"}\n'
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', (_, e) => (e.path in files ? { value: files[e.path]! } : { deny: 'ENOENT' }))
  on('fs.write', (_, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('tool.call', (_, e) => {
    edits.push(String((e as { file_path?: string }).file_path))
    return { result: { ok: true } } as never
  })
  return { base, files, edits }
}
const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: ['Edit'], outputStyle: { name: 'default', isKeepingCodingInstructions: true }, traits: [] } as never
const edit = (file_path: string) => ({ tool: 'Edit' as const, file_path, old_string: 'a', new_string: 'b' })
const approve = ($: Parameters<Parameters<typeof test>[1]>[0]) =>
  $.command.run({ command: 'approve-brief', args: '' } as never) as Promise<{ text?: string }>

test('on a feature branch, code edits wait for a brief', async ($, on) => {
  const { edits } = briefHarness(on)
  const r = (await $.tool.call(edit('/repo/src/a.ts'))) as { deny?: string }
  expect(r.deny).toContain('wait for the session brief')
  expect(r.deny).toContain('feature%2Fx.md')
  expect(edits).toEqual([])
})

test('on main, edits go through with no brief', async ($, on) => {
  const { edits } = briefHarness(on, { branch: 'main' })
  await $.tool.call(edit('/repo/src/a.ts'))
  expect(edits).toEqual(['/repo/src/a.ts'])
})

test('the brief itself can always be written, its approval file never', async ($, on) => {
  const { base, edits } = briefHarness(on)
  await $.tool.call({ tool: 'Write', file_path: `${base}.md`, content: '# T' })
  expect(edits).toEqual([`${base}.md`])
  const r = (await $.tool.call({ tool: 'Write', file_path: `${base}.approved.json`, content: '{}' })) as { deny?: string }
  expect(r.deny).toContain('only the person approves')
})

test('a draft brief names what is missing, and /approve-brief refuses it', async ($, on) => {
  briefHarness(on, { brief: '# T\n## Problem\nCurrently A.\n' })
  const r = (await $.tool.call(edit('/repo/src/a.ts'))) as { deny?: string }
  expect(r.deny).toContain('missing: user story, engineering outline')
  expect((await approve($)).text).toContain("Can't approve yet")
})

test('a complete brief asks for approval; once approved, edits go through and stay allowed', async ($, on) => {
  const { files, base, edits } = briefHarness(on, { brief: COMPLETE })
  expect(((await $.tool.call(edit('/repo/src/a.ts'))) as { deny?: string }).deny).toContain('not approved yet')
  expect((await approve($)).text).toContain('Brief approved')
  expect((await approve($)).text).toContain('already approved')
  expect(JSON.parse(files[`${base}.approved.json`]!).approvedAt).toBeGreaterThan(0)
  await $.tool.call(edit('/repo/src/a.ts'))
  expect(edits).toEqual(['/repo/src/a.ts'])
  files[`${base}.md`] = COMPLETE.replace('first thing', 'first and second thing')
  expect((await approve($)).text).toContain('Brief approved') // approving again after a change
  await $.tool.call(edit('/repo/src/b.ts'))
  expect(edits).toEqual(['/repo/src/a.ts', '/repo/src/b.ts'])
})

// ── The go-ahead (hooks/goahead.ts) ──────────────────────────────────────────
test('goAhead: a new approval starts chunk 1, a newer one carries on, an old or other-branch one says nothing', () => {
  const b = 'feature/x'
  expect(goAhead({ branch: b, approvedAt: null }, { branch: b, approvedAt: 5 }, 'Build it')).toContain('Start on chunk 1 (Build it)')
  expect(goAhead({ branch: b, approvedAt: 5 }, { branch: b, approvedAt: 9 })).toContain('change to the brief for feature/x is approved')
  expect(goAhead(null, { branch: b, approvedAt: 5 })).toBe(null) // approved before the session started
  expect(goAhead({ branch: 'other', approvedAt: null }, { branch: b, approvedAt: 5 })).toBe(null) // just switched branch
  expect(goAhead({ branch: b, approvedAt: 5 }, { branch: b, approvedAt: 5 })).toBe(null)
  expect(goAhead({ branch: b, approvedAt: 5 }, { branch: b, approvedAt: null })).toBe(null) // approval removed
})

test('approving the brief tells Claude to start, once', async ($, on) => {
  briefHarness(on, { brief: COMPLETE })
  const sent: string[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  let periods = 0
  on('clock.every', () => (++periods <= 6 ? { value: undefined } : { deny: 'enough' }))
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
  await new Promise(r => setTimeout(r, 20))
  expect(sent).toEqual([]) // nothing approved yet
  await approve($)
  periods = 0
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true }) // a reload: polls again from the saved state
  await new Promise(r => setTimeout(r, 30))
  expect(sent.length).toBe(1)
  expect(sent[0]).toContain('The brief for feature/x is approved. Start on chunk 1')
})

test('the system prompt explains the brief on a feature branch, not on main', async ($, on) => {
  briefHarness(on)
  on('prompt.compose', () => ({ sections: [] }))
  const { sections } = await $.prompt.compose(COMPOSE)
  const s = sections.find(x => x.id === 'session-rail-brief')
  expect(s?.text).toContain("Don't wait to be asked")
  expect(s?.text).toContain('one commit per chunk')
  expect(s?.text).toContain('Move straight on to the next chunk')
  expect(s?.text).toContain('Call the review_approach tool')
  expect(s?.text).toContain('/code-review --fix')
  expect(s?.text).toContain('final: true')
  expect(s?.scope).toBe('session')
})

test('main gets no brief section', async ($, on) => {
  briefHarness(on, { branch: 'main' })
  on('prompt.compose', () => ({ sections: [] }))
  const { sections } = await $.prompt.compose(COMPOSE)
  expect(sections.some(x => x.id === 'session-rail-brief')).toBe(false)
})

test('/start runs once per session, even when session.start runs again after a reload', async ($, on) => {
  const calls = harness(on, 'opened', ['help', 'start'])
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await new Promise(r => setTimeout(r, 10))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await new Promise(r => setTimeout(r, 10))
  expect(calls.filter(c => c === '/start').length).toBe(1)
})

test('a session started by the rail\'s + new does not run /start again', async ($, on) => {
  const calls = harness(on, 'opened', ['help', 'start'])
  on('env.get', (_, e) => ({ value: e.name === 'SESSION_RAIL_STARTED' ? '1' : undefined }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await new Promise(r => setTimeout(r, 10))
  expect(calls).toContain('pane.mjs layout')
  expect(calls).not.toContain('/start')
})

test('a command name the engine refuses does not stop the panels opening', async ($, on) => {
  const calls: string[] = []
  on('command.register', (_, e) => (e.name === 'desk' ? { deny: 'that name is taken' } : { value: { command: e.name } }))
  on('command.list', () => ({ value: [] }))
  on('process.run', (_, e) => {
    calls.push(`pane.mjs ${String(e.argv[4] ?? '')}`)
    return { value: { exitCode: 0, stdout: '{"state":"opened"}\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await new Promise(r => setTimeout(r, 10))
  expect(calls).toContain('pane.mjs layout')
})

// ── Live activity (hooks/activity.ts) ─────────────────────────────────────────
// The activity file is the last write to ~/.claude/session-rail/activity/<session id>.json.
const activityOf = async (files: Record<string, string>) => {
  await new Promise(r => setTimeout(r, 20)) // writes are chained; let them land
  return JSON.parse(files['/home/.claude/session-rail/activity/s1.json'] ?? 'null')
}
const withActivity = (on: Parameters<Parameters<typeof test>[1]>[1], opts: { branch?: string; brief?: string | null } = {}) => {
  const h = briefHarness(on, opts)
  on('env.get', () => ({ value: '/home' }))
  on('session.id', () => ({ value: 's1' }))
  return h
}

test('a finished tool call shows in the activity as just done, with its path relative to the repo', async ($, on) => {
  const { files } = withActivity(on, { branch: 'main' })
  await $.tool.call(edit('/repo/src/a.ts'))
  const a = await activityOf(files)
  expect(a.running).toEqual([])
  expect(a.recent[0]).toMatchObject({ tool: 'Edit', arg: 'src/a.ts', ok: true })
  expect(a.claude.state).toBe('thinking')
})

test('a refused edit is a failed call, and the gate records what it refused', async ($, on) => {
  const { files } = withActivity(on)
  await $.tool.call(edit('/repo/src/a.ts'))
  const a = await activityOf(files)
  expect(a.gate).toMatchObject({ tool: 'Edit', file: '/repo/src/a.ts' })
  expect(a.recent[0]).toMatchObject({ tool: 'Edit', ok: false })
})

// ── Auto-compaction (hooks/compact.ts) ────────────────────────────────────────
test('compact: leaving a feature branch counts, main or the same branch does not; a Done chunk is finished', () => {
  expect(compact.leftBranch('feature/x', 'main')).toBe('feature/x')
  expect(compact.leftBranch('feature/x', 'feature/y')).toBe('feature/x')
  expect(compact.leftBranch('main', 'feature/y')).toBe(null)
  expect(compact.leftBranch('feature/x', 'feature/x')).toBe(null)
  expect(compact.leftBranch(null, 'feature/x')).toBe(null)
  expect(compact.finished(COMPLETE)).toBe(false)
  expect(compact.finished(COMPLETE + 'Done: it works.\n')).toBe(true)
  expect(compact.finished(null)).toBe(false)
  expect(compact.instructions('feature/x', 'main')).toContain('Summarise feature/x')
})

// A repo whose branch the test switches; `merged` answers git merge-base --is-ancestor.
const compactHarness = (on: Parameters<Parameters<typeof test>[1]>[1], opts: { merged: boolean; done: boolean; setting?: string; fail?: boolean }) => {
  const repo = { branch: 'feature/x' }
  const brief = COMPLETE + (opts.done ? 'Done: it works.\n' : '')
  const files: Record<string, string> = { '/repo/.git/session-rail/briefs/feature%2Fx.md': brief }
  if (opts.setting) files['/home/.claude/session-rail/settings.json'] = opts.setting
  const compactions: string[] = []
  on('command.register', () => ({ value: { command: 'x' } }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.id', () => ({ value: 's1' }))
  on('env.get', () => ({ value: '/home' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    const isAncestor = e.argv.includes('--is-ancestor')
    const out = e.argv[0] === 'git' ? `/repo/.git\n${repo.branch}\n` : '{"state":"opened"}\n'
    return { value: { exitCode: isAncestor && !opts.merged ? 1 : 0, stdout: isAncestor ? '' : out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', (_, e) => (e.path in files ? { value: files[e.path]! } : { deny: 'ENOENT' }))
  on('fs.write', (_, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('session.compact', (_, e) => {
    compactions.push(String((e as { instructions?: string }).instructions))
    if (opts.fail) throw new Error('a turn is running')
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never
  })
  on('clock.every', () => ({ deny: 'the test polls by restarting the session' }))
  // Each session.start polls once right away, which is how the test steps the poll.
  const poll = async ($: Parameters<Parameters<typeof test>[1]>[0]) => {
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
    await new Promise(r => setTimeout(r, 30))
  }
  return { repo, files, compactions, poll }
}

test('leaving a finished, merged branch compacts once, and the activity records it', async ($, on) => {
  const { repo, files, compactions, poll } = compactHarness(on, { merged: true, done: true })
  await poll($)
  expect(compactions).toEqual([])
  repo.branch = 'main'
  await poll($)
  expect(compactions.length).toBe(1)
  expect(compactions[0]).toContain('The work on feature/x is merged')
  await poll($)
  expect(compactions.length).toBe(1)
  expect(JSON.parse(files['/home/.claude/session-rail/activity/s1.json']!).compacted).toMatchObject({ after: 'feature/x' })
})

for (const [name, opts] of [
  ['an unmerged branch', { merged: false, done: true }],
  ['a branch with no finished chunk', { merged: true, done: false }],
  ['auto-compact turned off', { merged: true, done: true, setting: '{"autoCompact":false}' }],
] as const)
  test(`leaving ${name} does not compact`, async ($, on) => {
    const { repo, compactions, poll } = compactHarness(on, opts)
    await poll($)
    repo.branch = 'feature/y'
    await poll($)
    expect(compactions).toEqual([])
  })

test('a compaction that keeps failing is tried 3 times, then dropped', async ($, on) => {
  const { repo, compactions, poll } = compactHarness(on, { merged: true, done: true, fail: true })
  await poll($)
  repo.branch = 'main'
  for (let i = 0; i < 5; i++) await poll($)
  expect(compactions.length).toBe(3)
})

// ── The review cadence (bin/cadence.mjs) ──────────────────────────────────────
const approachRun = (head: string, dirty: boolean, statuses: string[] = []) => ({
  type: 'approach', startedAt: 1, finishedAt: 2, head, dirty, verdict: statuses.length ? 'simpler-path' : 'on-track', summary: '',
  findings: statuses.map((status, i) => ({ id: `a-${i}`, kind: 'simpler', title: `finding ${i}`, detail: '', severity: 'medium', status })),
})
const report = (outcomes: (string | undefined)[]) => ({
  findings: outcomes.map((outcome, i) => ({ file: 'a.ts', line: i + 1, summary: `bug ${i}`, failure_scenario: 'x', ...(outcome ? { outcome } : {}) })),
})

test('cadence: a code report maps outcomes to statuses, and only the newest code review counts', () => {
  const first = cadence.codeRun(report([undefined, undefined]), { head: 'h', dirty: true, at: 5 })
  expect(first.findings.map(f => f.status)).toEqual(['open', 'open'])
  const fixed = cadence.codeRun(report(['fixed', 'no_change_needed']), { head: 'h', dirty: true, at: 6 })
  expect(fixed.findings.map(f => f.status)).toEqual(['applied', 'declined'])
  expect(cadence.openFindings([fixed, first]).code).toEqual([])
  expect(cadence.openFindings([first, fixed]).code.length).toBe(2)
  expect(cadence.codeRun(report(['skipped']), { head: 'h', dirty: true, at: 7 }).findings[0]).toMatchObject({ status: 'declined', outcome: 'skipped' })
})

test('cadence: checks mark earlier findings; untracked findings never count', () => {
  const runs = [approachRun('h', true, ['open', 'open']), { ...approachRun('h', true), findings: [{ title: 'old', acceptedAt: null }] }]
  expect(cadence.openFindings(runs).approach.length).toBe(2)
  const checked = cadence.applyChecks(runs, [{ id: 'a-0', status: 'applied' }, { id: 'a-1', status: 'declined', note: 'runs once' }])
  expect(cadence.openFindings(checked).approach).toEqual([])
  expect(checked[0]!.findings[1]).toMatchObject({ status: 'declined', note: 'runs once' })
})

// A repo on feature/x with an approved brief; the review record and HEAD are the test's.
const cadenceHarness = (on: Parameters<Parameters<typeof test>[1]>[1], runs: unknown[] = []) => {
  const files: Record<string, string> = {
    '/repo/.git/session-rail/briefs/feature%2Fx.md': COMPLETE,
    '/repo/.git/session-rail/briefs/feature%2Fx.approved.json': '{"approvedAt":1}',
    '/repo/.git/session-rail/reviews/feature%2Fx.json': JSON.stringify({ runs }),
  }
  const ran: string[] = []
  const calls: string[] = []
  on('session.cwd', () => ({ value: '/repo' }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__session-rail__review_approach' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    const a = e.argv.join(' ')
    if (e.argv[0] === 'mv') {
      files[e.argv[3]!] = files[e.argv[2]!]!
      delete files[e.argv[2]!]
    }
    calls.push(a)
    const out = a.includes('--git-common-dir') ? '/repo/.git\nfeature/x\n' : a.endsWith('rev-parse HEAD') ? 'h2\n' : a.includes('status --porcelain') ? ' M a.ts\n' : a.includes('reviewer.mjs') ? 'Approach review: on-track.\n' : ''
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', (_, e) => (e.path in files ? { value: files[e.path]! } : { deny: 'ENOENT' }))
  on('fs.write', (_, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('tool.call', (_, e) => {
    ran.push(e.tool === 'Bash' ? String((e as { command?: string }).command) : e.tool)
    return { result: { ok: true } } as never
  })
  return { files, ran, calls }
}

test('reportFromText takes the last JSON findings block', () => {
  const text = 'Found:\n```json\n[{"summary":"a"}]\n```\nFixed:\n```json\n[{"summary":"a","outcome":"fixed"}]\n```\nDone.'
  expect(cadence.reportFromText(text)).toEqual({ findings: [{ summary: 'a', outcome: 'fixed' }], run: null })
  expect(cadence.reportFromText('```json\n[]\n```')).toEqual({ findings: [], run: null })
  expect(cadence.reportFromText('```json\n{"run":"cr-1","findings":[]}\n```')).toEqual({ findings: [], run: 'cr-1' })
  expect(cadence.reportFromText('```json\n{"x":1}\n```')).toBeNull()
  expect(cadence.reportFromText('no block')).toBeNull()
  // A fence quoted inside a finding's text doesn't end the block.
  expect(cadence.reportFromText('```json\n[{"summary":"use ``` here","outcome":"fixed"}]\n```')).toEqual({ findings: [{ summary: 'use ``` here', outcome: 'fixed' }], run: null })
})

// /code-review is armed by the Skill tool running it (or the person typing it); its prompt carries the token.
const reviewHarness = (on: Parameters<Parameters<typeof test>[1]>[1]) => {
  const h = cadenceHarness(on)
  on('skill.prompt', () => ({ text: 'Review the diff.' }))
  on('turn.complete', () => ({ text: '' }))
  on('command.run', () => ({}))
  return h
}
const RECORD = '/repo/.git/session-rail/reviews/feature%2Fx.json'
const done = (agentId: string | undefined, answer: string, isAborted = false) =>
  ({ ...(agentId ? { agentId } : {}), answer, durationMs: 1, isAborted, turnId: 't', reason: 'answer' }) as never
const prompt = ($: Parameters<Parameters<typeof test>[1]>[0]) =>
  $.skill.prompt({ skill: 'code-review', text: 'Review the diff.', frontmatter: {} } as never).then(r => r.text)
const tokenOf = (text: string) => /"run": "([^"]+)"/.exec(text)?.[1] ?? ''
const block = (run: string | null, findings: unknown[]) => 'Done.\n```json\n' + JSON.stringify(run === null ? findings : { run, findings }) + '\n```'
const FINDINGS = [{ summary: 'off by one', outcome: 'fixed' }, { summary: 'docs', outcome: 'skipped' }, { summary: 'left' }]

test('a /code-review run is recorded from the answer that carries its token, whoever gives it', async ($, on) => {
  const { files } = reviewHarness(on)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  // Preloaded, not run: the prompt is left alone.
  expect(await prompt($)).toBe('Review the diff.')
  await $.tool.call({ tool: 'Skill', skill: 'code-review', args: '--fix' } as never)
  const text = await prompt($), token = tokenOf(text)
  expect(token).toMatch(/^cr-/)
  expect(await prompt($)).toBe('Review the diff.') // only the run's first prompt
  // A finder's bare list, another token, and a report before --fix (no outcomes) aren't it.
  await $.turn.complete(done('n1', block(null, [])))
  await $.turn.complete(done('x', block('cr-other', FINDINGS)))
  await $.turn.complete(done('f1', block(token, [{ summary: 'left' }])))
  expect(files[RECORD]).toBe(JSON.stringify({ runs: [] }))
  await $.turn.complete(done('f1', block(token, FINDINGS)))
  const saved = JSON.parse(files[RECORD]!).runs
  expect(saved[0]).toMatchObject({ type: 'code', head: 'h2' })
  expect(saved[0].findings.map((f: { status: string }) => f.status)).toEqual(['applied', 'declined', 'open'])
  // Recorded once: the run is over.
  await $.turn.complete(done('f1', block(token, [])))
  expect(JSON.parse(files[RECORD]!).runs.length).toBe(1)
})

test('an inline or typed /code-review is read from the main loop, and an aborted answer records nothing', async ($, on) => {
  const { files } = reviewHarness(on)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await $.command.run({ command: 'code-review', args: '--fix' } as never)
  const token = tokenOf(await prompt($))
  await $.turn.complete(done(undefined, block(token, []), true))
  expect(files[RECORD]).toBe(JSON.stringify({ runs: [] }))
  await $.turn.complete(done(undefined, block(token, [])))
  expect(JSON.parse(files[RECORD]!).runs[0]).toMatchObject({ type: 'code', verdict: 'clean' })
})

test('cadence: a check marks the finding checked, so a code finding is judged once', () => {
  const code = cadence.codeRun(report(['skipped']), { head: 'h', dirty: true, at: 5 })
  const id = code.findings[0]!.id
  const [after] = cadence.applyChecks([code], [{ id, status: 'open', note: 'a real bug' }])
  expect(after!.findings[0]).toMatchObject({ status: 'open', checked: true, note: 'a real bug' })
  expect(cadence.staffCheck([after!]).map(f => f.id)).toEqual([id]) // reopened: checked again until fixed
  const [ok] = cadence.applyChecks([code], [{ id, status: 'declined', note: 'docs only' }])
  expect(cadence.staffCheck([ok!])).toEqual([])
  expect(cadence.staffCheck([code]).map(f => f.id)).toEqual([id])
})

test('review_approach runs the reviewer\'s CLI with final and notes, and returns what it prints', async ($, on) => {
  const { calls } = cadenceHarness(on)
  const r = (await $.tool.call({ tool: 'mcp__session-rail__review_approach', final: true, notes: [{ id: 'a-0', note: 'runs once' }] } as never)) as { result?: string }
  expect(r.result).toBe('Approach review: on-track.')
  const run = calls.find(c => c.includes('reviewer.mjs'))!
  expect(run).toContain('--run --final --notes [{"id":"a-0","note":"runs once"}]')
})


test('cadence: a code finding the approach review reopened outlives the next /code-review until it is settled', () => {
  const first = cadence.codeRun(report(['skipped']), { head: 'h2', dirty: true, at: 5 })
  const id = first.findings[0]!.id
  const [reopened] = cadence.applyChecks([first], [{ id, status: 'open', note: 'a real bug' }])
  const next = cadence.codeRun(report([]), { head: 'h2', dirty: true, at: 6 }) // the new run doesn't raise it again
  expect(cadence.openFindings([next, reopened!]).code.map(f => f.id)).toEqual([id])
  expect(cadence.staffCheck([next, reopened!]).map(f => f.id)).toEqual([id])
  const settled = cadence.applyChecks([next, reopened!], [{ id, status: 'applied', note: 'fixed now' }])
  expect(cadence.openFindings(settled).code).toEqual([])
})

test('cadence: trimming the record keeps an older run that still holds an open finding', () => {
  const runs = Array.from({ length: cadence.KEEP_RUNS + 2 }, (_, i) => approachRun('h', false, i === cadence.KEEP_RUNS + 1 ? ['open'] : []))
  expect(cadence.keptRuns(runs).length).toBe(cadence.KEEP_RUNS + 1)
})

test('cadence: only gh pr merge is gated', () => {
  expect(cadence.mergesPr('gh pr merge 24 --merge && git checkout main')).toBe(true)
  expect(cadence.mergesPr('(gh pr merge 24)')).toBe(true)
  expect(cadence.mergesPr('git add -A && git commit -m "x"')).toBe(false)
  expect(cadence.mergesPr('echo "then gh pr merge"')).toBe(false)
})

test('cadence: a merge needs a code review after the chunks, then a final approach review on the clean last commit, nothing open', () => {
  const chunk = { ...approachRun('h1', true), startedAt: 5 }
  const code = cadence.codeRun(report([]), { head: 'h1', dirty: true, at: 10 }) // its fixes were committed after it: h1 → h2
  const final = { ...approachRun('h2', false), final: true, startedAt: 20 }
  expect(cadence.gateReason([final, code, chunk], { head: 'h2' })).toBe(null)
  // No code review since the last chunk's review.
  expect(cadence.gateReason([final, { ...chunk, startedAt: 15 }, code], { head: 'h2' })).toContain("/code-review hasn't run")
  // A final review before the code review, on an older commit, on a dirty tree, or not asked for as final doesn't count.
  for (const f of [{ ...final, startedAt: 8 }, { ...final, head: 'h1' }, { ...final, dirty: true }])
    expect(cadence.gateReason([f, code, chunk].sort((x, y) => y.startedAt - x.startedAt), { head: 'h2' })).toContain('final: true')
  // A non-final approach review after the code review is a chunk's review: the code review is stale again.
  expect(cadence.gateReason([{ ...final, final: false }, code, chunk], { head: 'h2' })).toContain("/code-review hasn't run")
  // One run from the desk on demand isn't a chunk's review.
  expect(cadence.gateReason([{ ...final, final: false, manual: true, startedAt: 25 }, final, code, chunk], { head: 'h2' })).toBe(null)
  // Open findings block it, with the two-round cap in the message.
  const r = cadence.gateReason([{ ...approachRun('h2', false, ['open']), final: true, startedAt: 20 }, code, chunk], { head: 'h2' })
  expect(r).toContain('1 open finding ("finding 0")')
  expect(r).toContain('at most two rounds')
  // So does a fixer's verdict the approach review hasn't judged.
  const fixed = cadence.codeRun(report(['fixed']), { head: 'h1', dirty: true, at: 10 })
  expect(cadence.gateReason([final, fixed, chunk], { head: 'h2' })).toContain("hasn't checked what /code-review's fixer did")
})

test('commits go through; gh pr merge waits for the final reviews; without the tool nothing is gated', async ($, on) => {
  const { ran } = cadenceHarness(on)
  await $.tool.call({ tool: 'Bash', command: 'gh pr merge 25 --merge' } as never) // the tool was never registered
  expect(ran).toEqual(['gh pr merge 25 --merge'])
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  const commit = ['git', 'commit', '-m', '"chunk 1"'].join(' ')
  await $.tool.call({ tool: 'Bash', command: commit } as never)
  expect(ran).toContain(commit)
  const r = (await $.tool.call({ tool: 'Bash', command: 'gh pr merge 25 --merge' } as never)) as { deny?: string }
  expect(r.deny).toContain('merge after a final review of the whole branch')
  expect(ran.filter(c => c.startsWith('gh pr merge')).length).toBe(1)
})
