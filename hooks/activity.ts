// What the session is doing right now, for the rail's Now section. register.ts feeds it from the engine's
// events and writes it to ~/.claude/session-rail/activity/<session id>.json; bin/sources.mjs reads it.
// Pure: no engine calls here.
import { nextCost } from '../bin/cost.mjs'

export type Call = { id: string; tool: string; arg: string; since: number; agent?: string }
export type Finished = { tool: string; arg: string; ok: boolean; at: number; ms: number; agent?: string }
// A subagent the plugin named at its spawn (bin/names.mjs): what it was asked, and when it ended, if it has.
export type Agent = {
  name: string; colour: number; what: string; since: number; background: boolean; endedAt?: number
  prompt?: string; reply?: string; parent?: string
}
export type Turn = { at: number; role: 'you' | 'main'; text: string }
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
  // The Stop test gate's latest run. A failure is also a row in `recent` (tool `test`), so the pet
  // flinches and droops the way it does for any failed call. `detail` is one line of the output.
  tests?: { at: number; ok: boolean; command: string; detail: string }
  // Subagents by agentId, named at their spawn: the live ones, and the last few that ended (so the story can name them).
  agents?: Record<string, Agent>
  // What the person asked and what the main agent answered, newest last. The transcript is the long copy.
  turns?: Turn[]
  // The plugin's latest compaction of the session, after the branch it finished.
  compacted?: { at: number; after: string }
  // The main conversation's prompt cache (bin/cache.mjs): when a request last renewed it, its lifetime, whether
  // the account is on a plan, and the prompt it holds in tokens.
  cache?: { at: number; ttl: '5m' | '1h'; plan: boolean; tokens: number; compactedAt?: number }
  // Claude's session ledger (bin/cost.mjs): the host's cost.usd, and the rise since the previous reading.
  cost?: { usd: number; at: number; turnUsd?: number }
}

const RECENT = 8
const ENDED = 10
const TURNS = 30
const oneLine = (s: unknown, n = 400) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

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
// The turn ended (or was stopped): Claude waits for the person, and nothing of the main thread is running. Its
// foreground subagents can't outlive it, so any still live (one stopped without an agentId on its abort) end too.
export function turnEnded(a: Activity, now: number): Activity {
  const live = Object.entries(a.agents ?? {}).filter(([, g]) => !g.endedAt && !g.background).map(([id]) => id)
  const ended = live.reduce((b, id) => agentEnded(b, id, now), a)
  return { ...ended, updatedAt: now, claude: { state: 'waiting', since: now, model: a.claude.model }, running: ended.running.filter(c => c.agent) }
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
// Either compaction leaves a short summary behind, so the cache's last request no longer holds a big prompt.
export function compacted(a: Activity, after: string, now: number): Activity {
  return { ...a, updatedAt: now, compacted: { at: now, after }, ...(a.cache ? { cache: { ...a.cache, compactedAt: now } } : {}) }
}
export function cached(a: Activity, cache: Activity['cache'], now: number): Activity {
  return cache === a.cache ? a : { ...a, updatedAt: now, cache }
}
// Claude's session.measure cost.usd. A reading that is not a usable total leaves the ledger as it was.
export function notedCost(a: Activity, usd: number, now: number): Activity {
  const cost = nextCost(a.cost, usd, now)
  return !cost || cost === a.cost ? a : { ...a, updatedAt: now, cost }
}
export function refused(a: Activity, tool: string, file: string, now: number): Activity {
  return { ...a, updatedAt: now, gate: { at: now, tool, file } }
}
// The Stop test gate. The same `at` recorded twice (the command hook and this module) is one row.
export function noteTests(a: Activity, note: { at?: number; ok?: boolean; command?: string; detail?: string; ms?: number }, now: number): Activity {
  const at = note.at || now
  const command = oneLine(note.command, 120)
  const ok = note.ok === true
  const detail = oneLine(note.detail, 200)
  const row: Finished = { tool: 'test', arg: command || 'tests', ok, at, ms: note.ms || 0 }
  const recent = [row, ...a.recent.filter(r => !(r.tool === 'test' && r.at === at))].slice(0, RECENT)
  return { ...a, updatedAt: now, recent, tests: { at, ok, command, detail } }
}
export function agentStarted(a: Activity, id: string, agent: Agent): Activity {
  return { ...a, updatedAt: agent.since, agents: { ...a.agents, [id]: agent } }
}
// Its own turn.complete: it stays in the record, marked ended, until ten later ones push it out. Any call it
// left in flight (it was stopped mid-call) goes with it.
export function agentEnded(a: Activity, id: string, now: number): Activity {
  const agent = a.agents?.[id]
  if (!agent || agent.endedAt) return a
  const agents = { ...a.agents, [id]: { ...agent, endedAt: now } }
  const ended = Object.entries(agents).filter(([, g]) => g.endedAt).sort(([, x], [, y]) => y.endedAt! - x.endedAt!)
  for (const [old] of ended.slice(ENDED)) delete agents[old]
  return { ...a, updatedAt: now, agents, running: a.running.filter(c => c.agent !== id) }
}
export function heard(a: Activity, text: string, now: number): Activity {
  const t = oneLine(text)
  if (!t) return a
  return { ...a, updatedAt: now, turns: [...(a.turns ?? []), { at: now, role: 'you' as const, text: t }].slice(-TURNS) }
}
export function replied(a: Activity, text: string, now: number): Activity {
  const t = oneLine(text)
  if (!t) return a
  return { ...a, updatedAt: now, turns: [...(a.turns ?? []), { at: now, role: 'main' as const, text: t }].slice(-TURNS) }
}
// What a subagent said when its turn ended. A missing agent, or an empty answer, leaves the record alone.
export function noteReply(a: Activity, id: string, text: string, now: number): Activity {
  const agent = a.agents?.[id]
  const t = oneLine(text, 800)
  if (!agent || !t) return a
  return { ...a, updatedAt: now, agents: { ...a.agents, [id]: { ...agent, reply: t } } }
}
