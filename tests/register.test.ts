import { expect, test } from 'claude-code/testing'

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

test('the system prompt explains the brief on a feature branch, not on main', async ($, on) => {
  briefHarness(on)
  on('prompt.compose', () => ({ sections: [] }))
  const { sections } = await $.prompt.compose(COMPOSE)
  const s = sections.find(x => x.id === 'session-rail-brief')
  expect(s?.text).toContain("Don't wait to be asked")
  expect(s?.text).toContain('one commit per chunk')
  expect(s?.text).toContain('Move straight on to the next chunk')
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
