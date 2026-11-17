// When to compact the session on its own: once it leaves a branch whose work is finished and merged, and while
// a big waiting session's prompt cache is still warm, just before it goes cold.
// register.ts tracks the branch and the cache and asks these; pure, no engine calls here.
import { NO_BRIEF_BRANCHES, parseBrief } from '../bin/brief.mjs'
import { cacheView } from '../bin/cache.mjs'

// The branch to consider compacting after, when the session moves from `prev` to `now` (null for none).
export function leftBranch(prev: string | null, now: string): string | null {
  return prev && prev !== now && !NO_BRIEF_BRANCHES.includes(prev) ? prev : null
}

// A branch's work is finished when its brief records at least one chunk as done.
export function finished(briefText: string | null): boolean {
  return briefText ? parseBrief(briefText).chunks.some(c => Boolean(c.done)) : false
}

const keep = (now: string) => [
  'Keep: the repo and where its issues are tracked (the project board and its statuses);',
  "how the person wants work done (the session brief workflow, the per-chunk procedure, commit, push and merge rules, the checks to run, anything they asked to remember or decided);",
  `open issues and what's next; the current branch ${now} and its brief, if it has one.`,
]

// What the summary keeps: how the person works and what's next; the finished branch shrinks to a line.
export function instructions(after: string, now: string): string {
  return [
    `The work on ${after} is merged and the session has moved on to ${now}.`,
    ...keep(now),
    `Summarise ${after} in a line or two (what shipped, its PR) and drop its back-and-forth.`,
  ].join(' ')
}

// ── Warm compact ──────────────────────────────────────────────────────────────
// The `after` a warm compact records in the activity file (the story says "before the cache went cold").
export const WARM = 'cache'
// The compaction's own request must start while the cache still holds: never closer to the expiry than this.
const MARGIN_MS = 15_000

// Due in the cache's last stretch (50 minutes into an hour, 4 into 5), while Claude waits with a context worth
// keeping warm and nothing compacted it since its last request. A cache already cold, as after a sleeping
// laptop, is left: compacting it then costs as much as the rebuild it was meant to avoid.
export function warmCompactDue(a: { cache: unknown; waiting: boolean; now: number }): boolean {
  const v = cacheView(a.cache, a.now)
  return Boolean(a.waiting && v?.worth && v.state === 'low' && v.leftMs > MARGIN_MS)
}

// The person is away mid-task: keep the work in hand whole, not only a line about it.
export function warmInstructions(now: string): string {
  return [
    'The person stepped away mid-task, and this compaction keeps the session cheap to resume.',
    ...keep(now),
    'Keep the task in hand in full: what it is, what is done, the files touched, the test command, and the next step.',
  ].join(' ')
}
