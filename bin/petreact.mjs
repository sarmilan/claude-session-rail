// Rules for the four pet reactions: context [!!!], the held ?, building mood, and growing.
// Pure: no Node APIs. The mascot draws; this decides when, and which mark wins.
import { isApproved } from './brief.mjs';

export const BANG_ON = 85, BANG_OFF = 80, BROW_ON = 50, BROW_OFF = 45;
export const HELD_ANNOY_MS = 8_000, HELD_PUSHY_MS = 12_000;
export const GROW_TICKS = 4, RELEASE_TICKS = 3;

// A brief that exists and is not approved (draft or ready). `changed` keeps the approval.
export const briefHolds = (status) => Boolean(status) && !isApproved(status);

// The earlier of "we first saw it unapproved" and a gate refusal, so a later refusal does not restart the clock
// and a refusal from before the rail was watching still counts.
export const heldAnchor = (noticed, gateAt) => {
  if (!Number.isFinite(noticed)) return Number.isFinite(gateAt) ? gateAt : 0;
  if (!Number.isFinite(gateAt)) return noticed;
  return Math.min(noticed, gateAt);
};

// Hysteresis. [!!!] latches at 85% and drops below 80%. The brow latches at 50% and drops below 45%.
export function latchContext(state, pct) {
  if (!Number.isFinite(pct)) return state;
  const p = Math.max(0, Math.min(100, pct));
  let { bang, brow } = state;
  if (p >= BANG_ON) bang = true;
  else if (p < BANG_OFF) bang = false;
  if (p >= BROW_ON) brow = true;
  else if (p < BROW_OFF) brow = false;
  return { bang, brow, pct: p };
}

// Body mood from the reading, independent of the brief's stage. Bulk is the ≥85 silhouette.
// The [!!!] latch can stay on down to 80% while the body has already stepped back to a stomp.
export function buildingOf({ pct, brow }) {
  if (!Number.isFinite(pct)) return 'none';
  if (pct >= BANG_ON) return 'bulk';
  if (pct >= BANG_OFF) return 'stomp';
  if (brow) return 'brow';
  return 'none';
}

export function heldPhase(elapsed, releasing) {
  if (releasing) return 'release';
  const t = Math.max(0, elapsed || 0);
  if (t < HELD_ANNOY_MS) return 'quiet';
  if (t < HELD_PUSHY_MS) return 'annoy';
  return 'pushy';
}

// One mark. Sleep and the puff outrank a pop; the held ? outranks [!!!]; [!!!] outranks the cache and gold READY.
// A warm-compact swirl hides [!!!] so the two never share a tick. Gold READY is only the brief-heavy flash.
export function markKind(f) {
  if (f.sleep) return f.cold ? 'frost' : null;
  if (f.puff) return 'puff';
  if (f.grow) return 'grow';
  if (f.shrink) return 'shrink';
  if (f.held) return 'query';
  if (f.droop) return 'droop';
  if (f.spark) return 'spark';
  if (f.bang && !f.swirl) return 'bang';
  if (f.swirl) return 'swirl'; // after the shrink, and never on the same ticks as [!!!]
  if (f.cold) return 'frost';
  if (f.low) return 'hourglass';
  if (f.ready) return 'ready';
  return null;
}

// In-place stomp while context is high. The turtle hops; the snail bounces; the crab dips.
export function stompArc(name, pct) {
  const high = (pct ?? 0) >= 90;
  if (name === 'crab') return high ? [0, -1, -2, -2, -1, 0] : [0, -1, -2, -1, 0];
  if (name === 'snail') return high ? [1, 2, 2, 1] : [1, 2, 1];
  return high ? [2, 3, 4, 4, 3, 2] : [1, 2, 3, 3, 2, 1];
}

// Bright for 3 ticks, dim for 3. Past 90%, two bright ticks then one dim.
export const bangBright = (tick, pct) => ((pct ?? 0) >= 90 ? tick % 3 !== 2 : Math.floor(tick / 3) % 2 === 0);

// `mul` is the ? scale (1 quiet, up to 2). `bob` is sprite pixels upward. Glow once the mark is past 1.2×.
export function queryMotion(phase, elapsed, tick, releaseTick) {
  if (phase === 'quiet') return { mul: 1, bob: Math.sin((tick || 0) * Math.PI / 4), glow: false, dim: false };
  if (phase === 'annoy') {
    const u = Math.max(0, Math.min(1, ((elapsed || 0) - HELD_ANNOY_MS) / (HELD_PUSHY_MS - HELD_ANNOY_MS)));
    const mul = 1 + u;
    return { mul, bob: Math.abs(Math.sin(u * 3 * Math.PI)) * (2 + 2 * u), glow: mul > 1.2, dim: false };
  }
  if (phase === 'pushy') return { mul: 2, bob: 0, glow: true, dim: Math.floor((tick || 0) / 2) % 5 === 4 };
  const step = Math.max(0, Math.min(2, releaseTick | 0));
  return { mul: [1.15, 0.5, 0.08][step], bob: 0, glow: false, dim: false };
}

// Where the head is, facing right, in sprite pixels. The crab's mark sits on the carapace, not a claw.
export const FACE = { snail: [28, 5], turtle: [30, 6], crab: [17, 3] };
export const RING_AT = { snail: [16, 10], turtle: [15, 8], crab: [17, 9] };

export function markAnchor(sideways, dir) {
  if (sideways) return 0.5;
  return dir < 0 ? 0.28 : 0.72;
}

// Twelve dots on a flat ellipse for a stage-up; a few grey motes inward for a shrink.
export function ringDots(tick, dir, cx, cy) {
  const t = Math.max(0, Math.min(GROW_TICKS - 1, tick | 0));
  const upColors = [231, 229, 220, 178];
  const n = dir === 'up' ? 12 : 6;
  // Wide enough to clear the shell and sit in the sky, still inside the strip.
  const radius = dir === 'up' ? 12 + t * 1.1 : Math.max(2, 11 - t * 2.4);
  const flat = dir === 'up' ? 0.72 : 0.55;
  const color = dir === 'up' ? upColors[t] : 245;
  const dots = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    dots.push({
      sx: Math.max(-2, Math.min(36, cx + Math.cos(a) * radius)),
      sy: Math.max(-6, Math.min(17, cy + Math.sin(a) * radius * flat)),
      color,
    });
  }
  return dots;
}

// Six puffs across the annoy window, drifting up and fading.
export function steamPuffs(elapsed, face) {
  if (elapsed < HELD_ANNOY_MS || elapsed >= HELD_PUSHY_MS) return [];
  const [fx, fy] = face;
  const out = [];
  for (let i = 0; i < 6; i++) {
    const age = elapsed - (HELD_ANNOY_MS + i * 520);
    if (age < 0 || age > 1500) continue;
    const k = age / 1500;
    out.push({ sx: fx + (i % 2 === 0 ? 1.2 : -1.2), sy: fy - k * 7, color: k > 0.65 ? 223 : 229 });
  }
  return out;
}

// Octant stand-in: one or two cells, blinking. Null means the bitmap mark (puff, droop, cache, gold).
export function octantMark(kind, o) {
  if (kind === 'bang') {
    const on = bangBright(o.tick, o.pct);
    if (!on && (o.pct ?? 0) < 90) return { text: '', color: 196 };
    return { text: o.width >= 24 ? '[!]' : '!', color: on ? 196 : 124 };
  }
  if (kind === 'query') {
    if (o.phase === 'quiet' && Math.floor(o.tick / 4) % 2 === 1) return { text: '', color: 220 };
    if (o.phase === 'release' && o.releaseTick >= 2) return { text: '', color: 220 };
    const dim = o.phase === 'pushy' && Math.floor(o.tick / 2) % 5 === 4;
    const text = o.phase === 'pushy' && o.width >= 22 ? '??' : '?';
    return { text, color: dim ? 178 : 220 };
  }
  if (kind === 'grow' && o.tick < 2) return { text: '*', color: 220 };
  if (kind === 'shrink' && o.tick < 2) return { text: '*', color: 245 };
  return null;
}

// The rail's one line, while the band is on. The pet is the signal; this is the action.
export function reactionHint({ held, bang, building, pct }) {
  if (held) return 'brief waiting for approval';
  if (bang && Number.isFinite(pct)) return `context ${Math.round(pct)}%, compact or wrap up?`;
  if (building === 'stomp' || building === 'bulk') return 'context is filling up';
  return null;
}
