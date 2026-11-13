// The rail's Now section, as plain data. hooks/activity.ts is the same machine for the Claude plugin;
// this copy is what the Grok hook writes, one process per event, into the same JSON file.
// The main agent's state is still called `claude` so the rail can read either host.

const RECENT = 8;
const ENDED = 10;

export const fresh = (now) => ({ updatedAt: now, claude: { state: 'waiting', since: now }, running: [], recent: [] });

export function turnStarted(a, model, now) {
  return { ...a, updatedAt: now, claude: { state: 'thinking', since: now, ...(model ?? a.claude?.model ? { model: model ?? a.claude.model } : {}) } };
}
export function turnEnded(a, now) {
  const live = Object.entries(a.agents ?? {}).filter(([, g]) => !g.endedAt && !g.background).map(([id]) => id);
  const ended = live.reduce((b, id) => agentEnded(b, id, now), a);
  return { ...ended, updatedAt: now, claude: { state: 'waiting', since: now, model: a.claude?.model }, running: ended.running.filter((c) => c.agent) };
}
export function callStarted(a, call) {
  const claude = call.agent ? a.claude : { state: 'tool', since: call.since, model: a.claude?.model };
  return { ...a, updatedAt: call.since, claude, running: [...(a.running ?? []), call] };
}
export function callFinished(a, id, ok, now) {
  const call = (a.running ?? []).find((c) => c.id === id);
  if (!call) return a;
  const running = a.running.filter((c) => c.id !== id);
  const next = { ...a, running };
  const busy = running.some((c) => !c.agent);
  const claude = call.agent || busy ? a.claude : { state: 'thinking', since: now, model: a.claude?.model };
  const done = { tool: call.tool, arg: call.arg, ok, at: now, ms: now - call.since, ...(call.agent ? { agent: call.agent } : {}) };
  return { ...next, updatedAt: now, claude, recent: [done, ...(a.recent ?? [])].slice(0, RECENT) };
}
export function compacted(a, after, now) {
  return { ...a, updatedAt: now, compacted: { at: now, after } };
}
export function refused(a, tool, file, now) {
  return { ...a, updatedAt: now, gate: { at: now, tool, file } };
}
export function agentStarted(a, id, agent) {
  return { ...a, updatedAt: agent.since, agents: { ...a.agents, [id]: agent } };
}
// Grok's Stop event lists what is still in flight (shell, subagent, monitor). The rail reads `tasks`
// the way it reads Claude's task index: shells are babies, subagents are fliers, and any of them keeps
// the pet busy after the turn has ended. A missing list leaves the previous one alone.
export function trackTasks(a, list, now) {
  if (!Array.isArray(list)) return a;
  const prior = new Map((a.tasks ?? []).map((t) => [t.id, t]));
  const tasks = [];
  for (const t of list) {
    if (!t?.id) continue;
    const kind = t.type === 'subagent' ? 'agent' : t.type === 'shell' ? 'shell' : t.type === 'monitor' ? 'monitor' : null;
    if (!kind) continue;
    const id = String(t.id);
    const label = String(t.command || t.description || t.agentType || kind).replace(/\s+/g, ' ').trim().slice(0, 120);
    tasks.push({ id, kind, label, agentType: t.agentType || null, startedAt: prior.get(id)?.startedAt || now, state: 'running' });
  }
  return { ...a, updatedAt: now, tasks };
}
export function agentEnded(a, id, now) {
  const agent = a.agents?.[id];
  if (!agent || agent.endedAt) return a;
  const agents = { ...a.agents, [id]: { ...agent, endedAt: now } };
  const ended = Object.entries(agents).filter(([, g]) => g.endedAt).sort(([, x], [, y]) => y.endedAt - x.endedAt);
  for (const [old] of ended.slice(ENDED)) delete agents[old];
  return { ...a, updatedAt: now, agents, running: (a.running ?? []).filter((c) => c.agent !== id) };
}
