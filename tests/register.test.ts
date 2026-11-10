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
