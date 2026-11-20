// Session spend the rail can show. Both hosts already keep a figure; this only reads it.
// Claude's is `cost.usd` on session.measure / session.usage() (SessionCost): the session ledger
// `/usage` and the status line show, in USD, reset when /clear starts a new session. It is not the
// 5-hour or 7-day plan window. Grok's is usage.json `costUsdTicks` (1e10 per dollar), the session
// total `grok usage` prints, plus the latest turn's ticks when that turn recorded them.
// A missing or unusable number stays absent. Nothing here prices tokens.

/** Grok's ledger: 1e10 ticks per dollar. A negative or non-numeric count is not a figure. */
export const TICKS_PER_USD = 1e10;
export function usdFromTicks(ticks) {
  if (typeof ticks !== 'number' || !Number.isFinite(ticks) || ticks < 0) return null;
  return ticks / TICKS_PER_USD;
}

/**
 * The cost record after a host reading of the session total. The same total leaves the record.
 * A lower total is a new ledger (Claude resets it on /clear), not a turn that spent backwards.
 * `turnUsd` is only the rise between two readings the host actually gave.
 * @param {{usd:number,at:number,turnUsd?:number}|undefined} prev
 */
export function nextCost(prev, usd, now) {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) return prev;
  if (prev && prev.usd === usd) return prev;
  const reset = Boolean(prev && typeof prev.usd === 'number' && usd < prev.usd);
  const delta = !reset && prev && typeof prev.usd === 'number' ? usd - prev.usd : null;
  return { usd, at: now, ...(delta > 0 ? { turnUsd: delta } : {}) };
}

/** The activity file's ledger, or null when the host has not given a usable total. */
export function recordedCost(cost) {
  const usd = cost?.usd;
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) return null;
  const turn = cost.turnUsd;
  return {
    costUsd: usd,
    ...(typeof turn === 'number' && Number.isFinite(turn) && turn > 0 ? { turnUsd: turn } : {}),
  };
}

/** Prefer the activity file's host ledger over a transcript total. No ledger leaves `stats` as it was. */
export function applyRecordedCost(stats, cost) {
  const booked = recordedCost(cost);
  if (!stats || !booked) return stats;
  const next = { ...stats, costUsd: booked.costUsd };
  if (booked.turnUsd != null) next.turnUsd = booked.turnUsd;
  else delete next.turnUsd;
  return next;
}

/** Dollars, without rounding a real sub-cent figure down to $0.00. */
export function formatUsd(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const abs = Math.abs(n);
  return `$${n.toFixed(abs > 0 && abs < 0.01 ? 4 : 2)}`;
}

/**
 * The Cost row. `—` when the host gave no figure.
 * The number is the host's own window (Claude's ledger until /clear, Grok's session total),
 * not a 5-hour or 7-day plan percent — those stay on the rows under it. The word "session"
 * is not printed, so the row matches the rail mock (`$1.87 · API 24m`).
 */
export function costText(stats) {
  const usd = stats?.costUsd;
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) return '—';
  let text = formatUsd(usd);
  const turn = stats.turnUsd;
  if (typeof turn === 'number' && Number.isFinite(turn) && turn > 0) text += ` · turn ${formatUsd(turn)}`;
  const api = stats.apiMs;
  if (typeof api === 'number' && Number.isFinite(api) && api >= 30_000)
    text += ` · API ${Math.max(1, Math.round(api / 60_000))}m`;
  return text;
}
