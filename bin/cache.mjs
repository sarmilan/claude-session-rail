// The main conversation's prompt cache: how long it lives (5 minutes on an API key, 1 hour on a plan), when it
// was last renewed, and what's left. register.ts records it from each main-loop request; the rail draws it.
// Pure, no Node APIs: shared by the hooks and the rail, like brief.mjs.

export const TTL_MS = { '5m': 300_000, '1h': 3_600_000 };
// The cache's last stretch, when the pet shows the hourglass: the last 10 minutes of an hour, the last minute of 5.
export const LOW_MS = { '5m': 60_000, '1h': 600_000 };
// Below this much context a cold resume is cheap, and a summary costs more than the rebuild it saves.
export const WORTH_TOKENS = 50_000;

/**
 * Which lifetime a request's cache write had, from its usage: '5m', '1h', or null when it wrote none.
 * When it wrote both, the larger write is the history's; a small side write doesn't set the clock.
 */
export function ttlFromUsage(usage) {
  const m5 = usage?.ephemeral_5m_input_tokens ?? 0, h1 = usage?.ephemeral_1h_input_tokens ?? 0;
  if (!m5 && !h1) return null;
  return h1 >= m5 ? '1h' : '5m';
}

/** The prompt a request sent, in tokens: what a cold cache would have to write again. */
export const promptTokens = (u) => (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);

/**
 * The cache after a main-loop request that started at `at`. A write sets the lifetime; a read alone renews the
 * one already known. A request that neither read nor wrote leaves the cache as it was.
 * @param {{at:number,ttl:'5m'|'1h',plan:boolean,tokens:number}|undefined} prev
 */
export function nextCache(prev, usage, at, plan) {
  if (!usage) return prev;
  const ttl = ttlFromUsage(usage) ?? (usage.cache_read_input_tokens > 0 ? prev?.ttl : null);
  if (!ttl) return prev;
  return { at, ttl, plan: Boolean(plan), tokens: promptTokens(usage) };
}

const ago = (ms) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)}m`);

/**
 * What the rail shows: `{ state: 'warm'|'low'|'cold', leftMs, worth, compacted, text }`, or null before the first request.
 * `worth` says the context is big enough that the cache going cold matters (the pet only reacts then).
 */
export function cacheView(cache, now) {
  if (!cache?.ttl || !TTL_MS[cache.ttl]) return null;
  const leftMs = cache.at + TTL_MS[cache.ttl] - now;
  const state = leftMs <= 0 ? 'cold' : leftMs <= LOW_MS[cache.ttl] ? 'low' : 'warm';
  const head = `${cache.plan ? 'plan' : 'API'} · ${cache.ttl}`;
  // Compacted since its last request: what's left is a short summary, so the cache going cold no longer matters.
  if (cache.compactedAt >= cache.at) return { state, leftMs, worth: false, compacted: true, text: `${head} · compacted warm ${ago(now - cache.compactedAt)} ago` };
  const tail = state === 'cold' ? `cold ${ago(-leftMs)}` : `warm ${ago(leftMs)} left`;
  return { state, leftMs, worth: (cache.tokens ?? 0) >= WORTH_TOKENS, compacted: false, text: `${head} · ${tail}` };
}
