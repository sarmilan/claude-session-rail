// What the session is doing right now, for the rail's Now section. register.ts feeds it from the engine's
// events and writes it to ~/.claude/session-rail/activity/<session id>.json; bin/sources.mjs reads it.
// Pure: no engine calls here.

export type Call = { id: string; tool: string; arg: string; since: number; agent?: string }
export type Finished = { tool: string; arg: string; ok: boolean; at: number; ms: number; agent?: string }
export type Activity = {
  updatedAt: number
  // Claude itself: thinking (a model request), running a tool, or waiting for the person.
  claude: { state: 'thinking' | 'tool' | 'waiting'; since: number; model?: string }
  // Tool calls in flight. A subagent's calls carry its agentId; Agent calls are the subagents themselves.
  running: Call[]
  // The last finished calls, newest first.
  recent: Finished[]
  // The brief gate's latest refusal.
  gate?: { at: number; tool: string; file: string }
  // The plugin's latest compaction of the session, after the branch it finished.
  compacted?: { at: number; after: string }
}

const RECENT = 8

export const fresh = (now: number): Activity => ({ updatedAt: now, claude: { state: 'waiting', since: now }, running: [], recent: [] })

// One short argument per tool, enough to say what it's doing: a path, a command, a pattern, a description.
export function summarise(tool: string, input: Record<string, unknown>, cwd: string): string {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const rel = (p: string) => (cwd && p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p)
  const arg =
    tool === 'Bash' ? s('command')
    : tool === 'Agent' ? [s('subagent_type'), s('description')].filter(Boolean).join(': ')
    : s('file_path') || s('notebook_path') ? rel(s('file_path') || s('notebook_path'))
    : s('pattern') || s('url') || s('query') || s('description') || s('prompt')
  return arg.replace(/\s+/g, ' ').trim().slice(0, 120)
}

const mainBusy = (a: Activity) => a.running.some(c => !c.agent)

export function turnStarted(a: Activity, model: string | undefined, now: number): Activity {
  return { ...a, updatedAt: now, claude: { state: 'thinking', since: now, ...(model ?? a.claude.model ? { model: model ?? a.claude.model } : {}) } }
}
// The turn ended (or was stopped): Claude waits for the person, and nothing of the main thread is running.
export function turnEnded(a: Activity, now: number): Activity {
  return { ...a, updatedAt: now, claude: { state: 'waiting', since: now, model: a.claude.model }, running: a.running.filter(c => c.agent) }
}
export function callStarted(a: Activity, call: Call): Activity {
  const claude = call.agent ? a.claude : { state: 'tool' as const, since: call.since, model: a.claude.model }
  return { ...a, updatedAt: call.since, claude, running: [...a.running, call] }
}
export function callFinished(a: Activity, id: string, ok: boolean, now: number): Activity {
  const call = a.running.find(c => c.id === id)
  if (!call) return a
  const running = a.running.filter(c => c.id !== id)
  const next = { ...a, running }
  const claude = call.agent || mainBusy(next) ? a.claude : { state: 'thinking' as const, since: now, model: a.claude.model }
  const done: Finished = { tool: call.tool, arg: call.arg, ok, at: now, ms: now - call.since, ...(call.agent ? { agent: call.agent } : {}) }
  return { ...next, updatedAt: now, claude, recent: [done, ...a.recent].slice(0, RECENT) }
}
export function compacted(a: Activity, after: string, now: number): Activity {
  return { ...a, updatedAt: now, compacted: { at: now, after } }
}
export function refused(a: Activity, tool: string, file: string, now: number): Activity {
  return { ...a, updatedAt: now, gate: { at: now, tool, file } }
}
