// The Session tab's story: who is working, the words they were handed, and how the problem got here.
// Pure (no Node APIs). The hooks and sources.mjs fill the record; the rail paints the segments this returns.
// Nothing in the banner or a row is guessed. The ask, the prompt and the reply are text that was sent.
import { clean, width, trunc } from './term.mjs';

const SPAWN = new Set(['Agent', 'Task', 'spawn_subagent']);
const GATE_HOLD = 2 * 60_000;

const show = (s) => clean(String(s ?? '')).replace(/\s+/g, ' ').trim();
const textOf = (parts) => (parts ?? []).map((p) => p.text).join('');
const wide = (parts) => width(textOf(parts));
const part = (text, style, colour) => (colour == null ? { text, style } : { text, style, colour });

export const oneLine = (s, n = 400) => show(s).slice(0, n);
// The prompt and the reply keep their line breaks. The row shows one line of the same text.
export const keep = (s, n = 1500) => String(s ?? '').replace(/\r/g, '').trim().slice(0, n);

export function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('\n');
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

// The person's words. A Grok turn wraps them in <user_query>; a bare system reminder is not a turn.
export function humanAsk(raw) {
  const text = typeof raw === 'string' ? raw : contentText(raw);
  const tagged = text.match(/<user_query>([\s\S]*?)<\/user_query>/);
  const body = oneLine(tagged ? tagged[1] : text);
  if (!body) return '';
  if (!tagged && /<(user_info|rules|system-reminder|available_skills)>/.test(text)) return '';
  return body.slice(0, 400);
}

// "Rue: review the diff" is the name the hook wrote and the one line it was given. A bare description has no name.
export function splitAsk(description) {
  const raw = show(description);
  const named = /^([A-Za-z][A-Za-z'-]{1,20}):\s+(\S.*)$/.exec(raw);
  if (!named) return { name: '', what: raw.slice(0, 160) };
  return { name: named[1], what: named[2].slice(0, 160) };
}

function argsOf(call) {
  const raw = call?.arguments ?? call?.function?.arguments ?? call?.input ?? {};
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return raw && typeof raw === 'object' ? raw : {};
}

function toolResultOnly(content) {
  return Array.isArray(content) && content.length > 0 && content.every((b) => b?.type === 'tool_result');
}

// One transcript row, Grok or Claude, as story events in the order they happened.
export function eventsFromRecord(row) {
  if (!row || typeof row !== 'object') return [];
  const msg = row.message && typeof row.message === 'object' ? row.message : row;
  const role = msg.role || row.type;
  if (role === 'user') {
    if (toolResultOnly(msg.content)) return [];
    const text = humanAsk(msg.content ?? row.content);
    return text ? [{ kind: 'you', text }] : [];
  }
  if (role !== 'assistant') return [];
  const out = [];
  const said = oneLine(contentText(msg.content ?? row.content));
  if (said) out.push({ kind: 'main', text: said });
  const calls = [];
  if (Array.isArray(row.tool_calls)) calls.push(...row.tool_calls);
  if (msg !== row && Array.isArray(msg.tool_calls)) calls.push(...msg.tool_calls);
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) if (block?.type === 'tool_use') calls.push({ name: block.name, arguments: block.input });
  }
  for (const call of calls) {
    const name = call.name || call.function?.name || '';
    if (!SPAWN.has(name)) continue;
    const args = argsOf(call);
    const ask = splitAsk(args.description || '');
    const prompt = oneLine(args.prompt, 1500);
    if (!ask.what && !prompt) continue;
    out.push({ kind: 'handoff', name: ask.name, what: ask.what, prompt });
  }
  return out;
}

function asList(agents) {
  if (Array.isArray(agents)) return agents.filter((a) => a?.id);
  return Object.entries(agents || {}).map(([id, g]) => ({ id, ...g }));
}

// The file has the prompt and the reply. The live feed has the name, the colour, and whether it is still going.
// One agent can arrive from both, under two ids. The same id, or the same full prompt, is one row. A shared
// preamble is not: the ask is the rest of the prompt. With no prompt, the ask (`what`) is the key.
function combineAgents(prev, a) {
  const live = a.endedAt ? prev : a;
  const other = live === a ? prev : a;
  return {
    ...prev,
    ...a,
    id: live.id || other.id,
    name: prev.name || a.name || '',
    what: prev.what || a.what || '',
    prompt: a.prompt || prev.prompt || '',
    reply: a.reply || prev.reply || '',
    colour: prev.colour ?? a.colour ?? null,
    parent: prev.parent || a.parent || null,
    since: prev.since || a.since || 0,
    endedAt: live.endedAt,
    background: Boolean(prev.background || a.background),
  };
}
const contentKey = (a) => (a.prompt ? `p:${a.prompt}` : (a.what ? `w:${a.what}` : ''));
export function mergeAgents(fileAgents, liveAgents) {
  const byId = new Map();
  const byContent = new Map();
  const order = [];
  const put = (a) => {
    if (!a?.id) return;
    const key = contentKey(a);
    const prev = byId.get(a.id) || (key && byContent.get(key)) || null;
    const next = prev ? combineAgents(prev, a) : { ...a, prompt: a.prompt || '', reply: a.reply || '' };
    if (!prev) order.push(next);
    else {
      const at = order.indexOf(prev);
      if (at >= 0) order[at] = next;
      if (prev.id) byId.set(prev.id, next);
      const prevKey = contentKey(prev);
      if (prevKey) byContent.set(prevKey, next);
    }
    if (next.id) byId.set(next.id, next);
    if (a.id !== next.id) byId.set(a.id, next);
    const nextKey = contentKey(next);
    if (nextKey) byContent.set(nextKey, next);
    if (key && key !== nextKey) byContent.set(key, next);
  };
  for (const a of fileAgents || []) put(a);
  for (const a of asList(liveAgents)) put(a);
  return order;
}

// The hook's turns repeat the transcript once it has caught up, and they skip the handoff lines in between.
// Append only the tail that is not already in the you/main events. A line the log has not written yet still lands.
export function mergeEvents(events, turns) {
  const out = (events || []).map((e) => ({ ...e }));
  const incoming = [];
  for (const t of turns || []) {
    const kind = t.role === 'you' ? 'you' : 'main';
    const text = oneLine(t.text);
    if (text) incoming.push({ kind, text, at: t.at });
  }
  if (!incoming.length) return out;
  const ym = out.filter((e) => e.kind === 'you' || e.kind === 'main');
  let accounted = 0;
  for (let start = 0; start < incoming.length; start++) {
    let i = start;
    for (const e of ym) {
      if (i >= incoming.length) break;
      if (e.kind === incoming[i].kind && e.text === incoming[i].text) i++;
    }
    if (i > start && i > accounted) accounted = i;
  }
  for (const t of incoming.slice(accounted)) out.push(t);
  return out;
}

function takeAgent(pool, handoff) {
  const same = (a) => !a.used && a.what && handoff.what && a.what === handoff.what;
  let i = pool.findIndex((a) => same(a) && a.reply);
  if (i < 0) i = pool.findIndex(same);
  if (i < 0 && handoff.prompt) {
    const head = oneLine(handoff.prompt, 60);
    i = pool.findIndex((a) => !a.used && a.prompt && oneLine(a.prompt, 60) === head);
  }
  const hit = i >= 0 ? pool[i] : null;
  if (hit) hit.used = true;
  return {
    id: hit?.id || handoff.id || '',
    name: hit?.name || handoff.name || '',
    what: hit?.what || handoff.what || '',
    prompt: handoff.prompt || hit?.prompt || '',
    reply: hit?.reply || handoff.reply || '',
    colour: hit?.colour ?? handoff.colour ?? null,
    since: hit?.since || 0,
    endedAt: hit?.endedAt,
  };
}

// Chapters follow the person's prompts. The line before a handoff is why it was asked. The last line of the
// chapter is what the main agent answered. Newest first.
export function chaptersFrom(events, agents) {
  const pool = (agents || []).map((a) => ({ ...a, used: false }));
  const chapters = [];
  let cur = null;
  for (const e of events || []) {
    if (e.kind === 'you') {
      cur = { key: `you:${chapters.length}`, at: e.at || 0, you: e.text, why: '', reply: '', handoffs: [] };
      chapters.push(cur);
      continue;
    }
    if (e.kind === 'handoff' && !cur) {
      const h = takeAgent(pool, e);
      if (h.id) h.key = h.id;
      chapters.push({ key: `hand:${h.id || chapters.length}`, at: e.at || 0, you: '', why: '', reply: '', handoffs: [h], lone: true });
      continue;
    }
    if (!cur) continue;
    if (e.kind === 'main') {
      const text = oneLine(e.text);
      if (!text) continue;
      if (!cur.handoffs.length) cur.why = text;
      cur.reply = text;
    } else if (e.kind === 'handoff') cur.handoffs.push(takeAgent(pool, e));
  }
  const usedWhat = new Set();
  const usedId = new Set();
  for (const c of chapters) for (const h of c.handoffs) {
    if (h.id) usedId.add(h.id);
    if (h.what) usedWhat.add(h.what);
  }
  const left = pool.filter((a) => !a.used && a.id && !usedId.has(a.id) && !(a.what && usedWhat.has(a.what)));
  const live = left.filter((a) => !a.endedAt);
  const old = left.filter((a) => a.endedAt);
  const asHandoff = (a) => ({ id: a.id, name: a.name || '', what: a.what || '', prompt: a.prompt || '', reply: a.reply || '', colour: a.colour ?? null });
  if (live.length) {
    if (!chapters.length) chapters.push({ key: 'you:live', at: 0, you: '', why: '', reply: '', handoffs: live.map(asHandoff), lone: true });
    else chapters[chapters.length - 1].handoffs.push(...live.map(asHandoff));
  }
  for (const a of old) chapters.push({ key: `hand:${a.id}`, at: a.since || 0, you: '', why: '', reply: '', handoffs: [asHandoff(a)], lone: true });
  return chapters.reverse();
}

const VERB = {
  Read: 'reading', read_file: 'reading', Grep: 'searching', grep: 'searching',
  Bash: 'running', run_terminal_command: 'running', Edit: 'editing', Write: 'writing',
  search_replace: 'editing', write: 'writing',
};

function shortArg(arg) {
  const s = show(arg);
  if (!s) return '';
  if (s.includes('/')) return s.split('/').pop() || s;
  return s.slice(0, 42);
}

function doingText(call) {
  if (!call) return '';
  const verb = VERB[call.tool] || call.tool;
  const arg = shortArg(call.arg);
  return show(arg ? `${verb} ${arg}` : verb);
}

function ago(at, now) {
  if (!at || at < 1e11) return '';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function link(cast) {
  const by = new Map(cast.map((a) => [a.id, { ...a, children: [] }]));
  const roots = [];
  for (const n of by.values()) {
    const parent = n.parent ? by.get(n.parent) : null;
    if (parent && parent !== n) parent.children.push(n);
    else roots.push(n);
  }
  const bySince = (a, b) => (a.since || 0) - (b.since || 0);
  for (const n of by.values()) n.children.sort(bySince);
  roots.sort(bySince);
  return roots;
}

function bannerParts(story) {
  const tone = story.banner.tone;
  const head = [part('▌', tone), part(story.banner.kind === 'held' ? ' Held' : ' Now', tone), part('  ', 'plain')];
  return [...head, part(story.banner.text, 'plain')];
}

function fit(parts, inner) {
  const out = [];
  let used = 0;
  for (const p of parts) {
    const room = inner - used;
    if (room <= 0) break;
    if (width(p.text) <= room) { out.push(p); used += width(p.text); }
    else { out.push({ ...p, text: trunc(p.text, room) }); break; }
  }
  return out;
}

function hostDoing(story) {
  const call = (story.running || []).filter((c) => c && !c.agent && !SPAWN.has(c.tool)).at(-1);
  return doingText(call);
}

function agentCall(agent, running) {
  return (running || []).filter((c) => c?.agent === agent.id).at(-1);
}
function agentDoing(agent, running) {
  return doingText(agentCall(agent, running));
}
// The collapsed row's lamp is the verb. The file it is touching shows once the row is open.
function agentLamp(agent, running) {
  const call = agentCall(agent, running);
  if (!call) return '';
  return VERB[call.tool] || call.tool;
}

/**
 * The record the rail draws. `agents` is the live map or a list. `fileAgents` and `events` come from the
 * session's own transcript. `turns` are the ones the hook just heard, which the transcript may not have yet.
 */
export function buildStory({
  host = 'Claude', claude = null, gate = null, agents = null, fileAgents = [], events = [], turns = [],
  running = [], recent = [], tasks = [], desk = null, compacted = null, now = Date.now(),
} = {}) {
  const everyone = mergeAgents(fileAgents, agents);
  const cast = link(everyone.filter((a) => !a.endedAt));
  const chapters = chaptersFrom(mergeEvents(events, turns), everyone);
  let banner;
  if (gate && now - gate.at < GATE_HOLD) {
    const file = show(gate.file || '').split('/').pop();
    banner = { kind: 'held', tone: 'yellow', text: show(`brief stopped ${gate.tool || 'an edit'}${file ? ` ${file}` : ''}`) };
  } else if (cast.length === 1 && !cast[0].children.length) {
    banner = { kind: 'now', tone: 'accent', text: show(`${cast[0].name || 'agent'}${cast[0].what ? ` · ${cast[0].what}` : ''}`) };
  } else if (cast.length > 1 || cast[0]?.children?.length) {
    const names = [];
    const walk = (n) => { names.push(n.name || 'agent'); n.children.forEach(walk); };
    cast.forEach(walk);
    const shown = names.slice(0, 3);
    const more = names.length - shown.length;
    let text = shown.length === 2 ? `${shown[0]} and ${shown[1]}` : shown.join(', ');
    if (more > 0) text += ` and ${more} more`;
    banner = { kind: 'now', tone: 'accent', text };
  } else if (claude?.state === 'thinking') {
    banner = { kind: 'now', tone: 'accent', text: 'thinking' };
  } else if (claude?.state === 'tool' || hostDoing({ running })) {
    banner = { kind: 'now', tone: 'accent', text: hostDoing({ running }) || 'working' };
  } else if ((running || []).some((c) => c && SPAWN.has(c.tool) && !c.agent)) {
    banner = { kind: 'now', tone: 'accent', text: 'handing work off' };
  } else {
    banner = { kind: 'now', tone: 'dim', text: 'waiting for you' };
  }
  const said = [...(events || []), ...(turns || []).map((t) => ({ kind: t.role === 'you' ? 'you' : 'main', text: t.text }))]
    .filter((e) => e.kind === 'main' && e.text).at(-1)?.text || '';
  // Every subagent that has finished, newest first. The live ones stay in the cast above this list.
  const history = everyone.filter((a) => a.endedAt)
    .sort((a, b) => (b.endedAt || b.since || 0) - (a.endedAt || a.since || 0));
  return { host, claude, banner, cast, history, chapters, running: running || [], recent: recent || [], tasks: tasks || [], desk, compacted, said: oneLine(said), now };
}

function push(rows, inner, row) {
  // The left side is the name and the ask. The right side is a lamp, and it gives way so the ask stays.
  const minLeft = Math.min(22, Math.max(8, inner - 8));
  let right = row.right || [];
  if (right.length && wide(right) + 1 + minLeft > inner) right = fit(right, Math.max(0, inner - minLeft - 1));
  const gap = right.length && wide(right) ? 1 : 0;
  if (!wide(right)) right = [];
  rows.push({
    id: row.id || null,
    key: row.key || null,
    activate: row.activate || null,
    title: row.title || '',
    body: row.body || '',
    taskId: row.taskId || null,
    left: fit(row.left, Math.max(1, inner - wide(right) - gap)),
    right,
  });
}

function field(label, value) {
  return [part(label.padEnd(7), 'dim'), part(show(value), 'plain')];
}

function preview(s) {
  const line = oneLine(s, 240);
  return line;
}

/**
 * Rows for one frame. `open` is { [key]: true } for a host, an agent, or a chapter expanded in place.
 * Enter on a prompt or a reply opens the stored text. The tree never invents a reason.
 */
export function layoutStory(story, { inner = 40, open = {} } = {}) {
  const rows = [];
  const now = story.now || Date.now();
  const hostKey = 'who:main';
  const hostOpen = Boolean(open[hostKey]);
  // The banner is the only status. This row is the caret for the call log, so it carries no second
  // "waiting" or "reading", and the reply under it does not repeat the name.
  push(rows, inner, {
    id: hostKey, key: hostKey, activate: 'toggle',
    left: [part(hostOpen ? '▾ ' : '▸ ', 'dim'), part('● ', 'accent'), part(story.host || 'Claude', 'bold')],
  });
  if (story.said) {
    const lead = [part(hostOpen ? '     ' : '  ', 'plain')];
    push(rows, inner, {
      id: 'read:main:said', key: hostKey, activate: 'read', title: `${story.host} · said`, body: story.said,
      left: hostOpen ? [...lead, ...field('said', preview(story.said))] : [...lead, part(preview(story.said), 'plain')],
    });
  }
  if (hostOpen) {
    const lead = [part('     ', 'plain')];
    const calls = (story.recent || []).filter((r) => r && !r.agent && !SPAWN.has(r.tool)).slice(0, 4);
    for (const r of calls) {
      push(rows, inner, {
        left: [...lead, part(r.ok === false ? '✗ ' : '✔ ', r.ok === false ? 'red' : 'green'), part(show(`${r.tool} ${shortArg(r.arg)}`), 'dim')],
      });
    }
  }
  const emit = (list, prefix) => {
    list.forEach((node, i) => {
      const last = i === list.length - 1;
      const key = `who:${node.id}`;
      const isOpen = Boolean(open[key]);
      const limb = [part(last ? '└' : '├', 'dim'), part(isOpen ? '▾' : '▸', 'dim'), part(' ◆ ', 'plain', node.colour)];
      const name = node.name || 'agent';
      // One live agent: the banner already says the ask, so the row is the name and the lamp.
      const sole = story.cast.length === 1 && !story.cast[0].children?.length && node === story.cast[0];
      const what = node.what && !sole ? node.what : '';
      const rightText = agentLamp(node, story.running) || ago(node.since, now);
      push(rows, inner, {
        id: key, key, activate: 'toggle',
        left: [...prefix, ...limb, part(name, 'bold', node.colour), part(what ? `  ${what}` : '', 'plain')],
        right: rightText ? [part(rightText, 'dim')] : [],
      });
      const nest = [...prefix, part(last ? '  ' : '│ ', 'dim')];
      if (isOpen) {
        const lead = [...nest, part('   ', 'plain')];
        if (node.what) push(rows, inner, { left: [...lead, ...field('asked', node.what)] });
        const prompt = node.prompt || '';
        if (prompt && oneLine(prompt) !== oneLine(node.what)) {
          push(rows, inner, {
            id: `read:${node.id}:prompt`, key, activate: 'read', title: `${name} · prompt`, body: prompt,
            left: [...lead, ...field('prompt', preview(prompt))],
          });
        }
        const live = agentDoing(node, story.running);
        if (live) push(rows, inner, { left: [...lead, ...field('doing', live)] });
        if (node.reply) {
          push(rows, inner, {
            id: `read:${node.id}:said`, key, activate: 'read', title: `${name} · said`, body: node.reply,
            left: [...lead, ...field('said', preview(node.reply))],
          });
        }
        const done = (story.recent || []).filter((r) => r?.agent === node.id).slice(0, 4);
        for (const r of done) {
          push(rows, inner, {
            left: [...lead, part(r.ok === false ? '✗ ' : '✔ ', r.ok === false ? 'red' : 'green'), part(show(`${r.tool} ${shortArg(r.arg)}`), 'dim')],
          });
        }
      }
      emit(node.children, nest);
    });
  };
  emit(story.cast, [part('  ', 'plain')]);
  for (const t of story.tasks || []) {
    if (!t?.id || t.kind === 'agent') continue;
    if (story.cast.some((n) => n.id === t.id)) continue;
    push(rows, inner, {
      id: `task:${t.id}`, key: `task:${t.id}`, activate: 'log', taskId: t.id,
      left: [part('  └▸ ◇ ', 'dim'), part(show(t.label || t.kind), 'plain')],
      right: [part(ago(t.startedAt, now), 'dim')],
    });
  }
  if (story.desk) {
    push(rows, inner, {
      left: [part('  ◆ ', 'accent'), part('Desk', 'bold'), part(`  ${show(story.desk.kind || 'running')}`, 'plain')],
    });
  }
  // Finished subagents stay listed, each with the task it was given. Enter opens the prompt and the reply.
  for (const [i, h] of (story.history || []).entries()) {
    const key = `past:${h.id || i}`;
    const hOpen = Boolean(open[key]);
    const name = h.name || 'agent';
    push(rows, inner, {
      id: key, key, activate: 'toggle',
      left: [part(hOpen ? '▾ ' : '▸ ', 'dim'), part('◆ ', 'plain', h.colour), part(name, 'bold', h.colour), part(h.what ? `  ${h.what}` : '', 'plain')],
      right: [part(ago(h.endedAt || h.since, now), 'dim')],
    });
    if (hOpen) emitHandoff(rows, inner, h, [part('  ', 'plain')], name, key);
  }
  if (story.chapters.length || story.compacted) {
    if (story.compacted) {
      push(rows, inner, {
        left: [part(`⟲ compacted after ${show(story.compacted.after)}`, 'accent')],
        right: [part(ago(story.compacted.at, now), 'dim')],
      });
    }
    for (const chapter of story.chapters) {
      if (!chapter.you) continue;
      const isOpen = Boolean(open[chapter.key]);
      push(rows, inner, {
        id: chapter.key, key: chapter.key, activate: 'toggle',
        left: [part(isOpen ? '▾ ' : '▸ ', 'dim'), part('you  ', 'dim'), part(chapter.you, 'plain')],
        right: [part(ago(chapter.at, now), 'dim')],
      });
      if (!isOpen) continue;
      const lead = [part('│    ', 'dim')];
      if (chapter.why && chapter.why !== chapter.reply) push(rows, inner, { left: [...lead, ...field('why', chapter.why)] });
      // The newest reply is already under Now. A chapter prints a reply only when it is a different one.
      if (chapter.reply && oneLine(chapter.reply) !== oneLine(story.said)) {
        push(rows, inner, {
          id: `read:${chapter.key}:reply`, key: chapter.key, activate: 'read', title: `${story.host} · said`, body: chapter.reply,
          left: [...lead, part(preview(chapter.reply), 'plain')],
        });
      }
    }
  }
  return { banner: fit(bannerParts(story), inner), rows };
}

function emitHandoff(rows, inner, h, lead, name, key) {
  if (h.what) push(rows, inner, { left: [...lead, ...field('asked', h.what)] });
  if (h.prompt && oneLine(h.prompt) !== oneLine(h.what)) {
    push(rows, inner, {
      id: `read:${key}:prompt`, key, activate: 'read', title: `${name} · prompt`, body: h.prompt,
      left: [...lead, ...field('prompt', preview(h.prompt))],
    });
  }
  if (h.reply) {
    push(rows, inner, {
      id: `read:${key}:said`, key, activate: 'read', title: `${name} · said`, body: h.reply,
      left: [...lead, ...field('said', preview(h.reply))],
    });
  }
}
