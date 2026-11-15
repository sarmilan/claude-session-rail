// Which document the Plan tab shows, and when a change of it selects that tab. Pure, no Node APIs.

const hasText = (doc) => typeof doc?.text === 'string' && doc.text !== '';

/**
 * `brief` when the brief has text and the plan file is not newer. `plan` when the plan file is the body.
 * `note` when there is nothing to read.
 * @param {{ text?: string | null, mtime?: number } | null} brief
 * @param {{ text?: string | null, mtime?: number } | null} plan
 */
export function planChoice(brief, plan) {
  const briefText = hasText(brief);
  const planText = hasText(plan);
  if (briefText && !(planText && plan.mtime > (brief.mtime ?? 0))) return 'brief';
  if (planText) return 'plan';
  return 'note';
}

/** Path and mtime of whichever documents have text. A branch name is not part of it. */
export function planSignature(plan, brief) {
  const planPart = hasText(plan) ? `${plan.path}:${plan.mtime}` : '';
  const briefPart = hasText(brief) ? `${brief.path}:${brief.mtime}` : '';
  return `${planPart}|${briefPart}`;
}

/** The first reading does not select Plan. A later change of the plan file or the brief does. */
export function notePlan(prev, plan, brief) {
  const sig = planSignature(plan, brief);
  return { sig, select: prev !== undefined && prev !== sig };
}
