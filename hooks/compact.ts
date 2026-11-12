// When to compact the session on its own: once it leaves a branch whose work is finished and merged.
// register.ts tracks the branch and asks these; pure, no engine calls here.
import { NO_BRIEF_BRANCHES, parseBrief } from '../bin/brief.mjs'

// The branch to consider compacting after, when the session moves from `prev` to `now` (null for none).
export function leftBranch(prev: string | null, now: string): string | null {
  return prev && prev !== now && !NO_BRIEF_BRANCHES.includes(prev) ? prev : null
}

// A branch's work is finished when its brief records at least one chunk as done.
export function finished(briefText: string | null): boolean {
  return briefText ? parseBrief(briefText).chunks.some(c => Boolean(c.done)) : false
}

// What the summary keeps: how the person works and what's next; the finished branch shrinks to a line.
export function instructions(after: string, now: string): string {
  return [
    `The work on ${after} is merged and the session has moved on to ${now}.`,
    'Keep: the repo and where its issues are tracked (the project board and its statuses);',
    "how the person wants work done (the session brief workflow, the per-chunk procedure, commit, push and merge rules, the checks to run, anything they asked to remember or decided);",
    `open issues and what's next; the current branch ${now} and its brief, if it has one.`,
    `Summarise ${after} in a line or two (what shipped, its PR) and drop its back-and-forth.`,
  ].join(' ')
}
