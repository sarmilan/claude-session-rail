import { expect, test } from 'claude-code/testing'

// Each hook below stands for the engine. process.run records the controller action asked for.
const harness = (on: Parameters<Parameters<typeof test>[1]>[1], reply = 'opened') => {
  const calls: string[] = []
  on('command.register', () => ({ value: { command: 'rail' } }))
  on('process.run', (_, e) => {
    const argv = e.argv ?? []
    // argv: sh -c 'exec node "$0" "$1"' <plugin root>/bin/pane.mjs <action>
    calls.push(`${String(argv[3] ?? '').endsWith('/bin/pane.mjs') ? 'pane.mjs' : '?'} ${String(argv[4] ?? '')}`)
    return { value: { exitCode: 0, stdout: `{"state":"${reply}"}\n`, stderr: '' } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('command.run', () => ({}))
  return calls
}

test('a terminal session opens the rail on start', async ($, on) => {
  const calls = harness(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await new Promise(r => setTimeout(r, 0))
  expect(calls).toEqual(['pane.mjs open'])
})

test('a non-interactive or desktop session does not open it', async ($, on) => {
  const calls = harness(on)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await new Promise(r => setTimeout(r, 0))
  expect(calls.length).toBe(0)
})

test('/rail toggles and reports the result', async ($, on) => {
  const calls = harness(on, 'closed')
  const result = await $.command.run({ command: 'rail', args: '' })
  expect(calls).toEqual(['pane.mjs toggle'])
  expect(result.text).toBe('Rail closed.')
})

test('session end closes the rail, but /clear keeps it', async ($, on) => {
  const calls = harness(on, 'closed')
  await $.session.end({ reason: 'clear', sessionId: 'a' })
  expect(calls.length).toBe(0)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'a' })
  expect(calls).toEqual(['pane.mjs close'])
})
