// What Grok is told about the session brief. The Claude plugin puts the same procedure in the system
// prompt (hooks/register.ts). Grok has no prompt.compose hook, so the Grok hook writes this file and
// attaches it to the first tool call of a session (and again after a compaction).

const SHAPE = `# <title>
## Problem
Currently <A>; we need <B> to solve <A>.
## Solution
As a <who>, I should be able to <what> so I can <why>.
## Design
The design and UI/UX decisions.
## Mockups
ASCII mockups, in a code block.
## Engineering
### Chunk 1: <name>
A rough outline of the changes for this part of the goal.
### Chunk 2: <name>
…`;

export function briefInstructions(b, reviewer) {
  const review = reviewer || 'node <plugin>/bin/reviewer.mjs --run';
  return `Session brief (session-rail). This branch, ${b.branch}, keeps a session brief at ${b.path}. It's a local file inside .git, never committed. It's what the session sets out to do and what the work is checked against at the end.

Work the brief out with the person before editing any code. Don't wait to be asked: as soon as the discussion makes the problem and the solution clear, tell the person it's scoped out and write the brief, then summarise it for them in a few lines and say it's in the desk's Plan tab. Keep filling it in as the discussion goes on (design, mockups, engineering chunks). Write it in this shape:

${SHAPE}

Keep the solution and the outline the simplest way to reach the goal. search_replace and write on any other file are refused until the brief has a problem, a solution and at least one chunk, and the person has approved it. When it's complete, run the approach review (${review}), work its findings into the brief, then ask them to review it and press Approve in the desk's Plan tab (or type /approve-brief). Never approve it yourself or write its approval file.

While you work, keep the brief current: if the problem, the solution or the outline changes, update the brief right away.

Work through the chunks in order. When you finish one:
1. Review it yourself against its outline and the brief's Problem and Solution: is it complete, is it the simplest way, and does it work (run the tests and checks)? Fix what falls short first. If the plan itself has to change, update the brief and say so.
2. When it's satisfactory, add two lines under the chunk's outline:
Done: <a short happy-path summary: what changed and how it works end to end>
Files: <comma-separated paths relative to the repo root>
3. Run the approach review again (${review}). Apply each finding and update the brief to match; if one shouldn't be applied, pass your reason with --notes '[{"id":"<id>","note":"<why>"}]'. Run it once more to check them, at most two rounds; if something is still open after that, say so to the person.
4. Run what the chunk built once for real (the command, the UI frame, the hook in a live session), not only its tests, and fix what that shows.
5. Commit the chunk on its own: one commit per chunk, its message naming the chunk.
6. Push the branch. After the first chunk's commit, also open a pull request for the branch, titled after the brief, with its Problem and Solution as the description and a Progress checklist of the chunks; tick each chunk as it lands, noting its approach review (for example "review: 2 findings, applied"). Later pushes update it.
7. Move straight on to the next chunk without waiting for the person, unless something needs their decision.

Before merging, which waits for the person to say so: run /review over the whole branch (against the default branch) and commit and push its fixes. End that review's final message with a \`\`\`json block {"findings":[{"summary":"...","short_summary":"...","file":"...","line":1,"outcome":"fixed"|"skipped"|"no_change_needed"}]}. Then run ${review} --final so it checks what the fixer did. Apply what it finds, commit and push, and run it with --final once more to check them, at most two rounds. If something is still open after that, list it in the PR and ask the person instead of looping. The plugin refuses gh pr merge until the code review has run since the last chunk's review, the final approach review has run after it on the last commit with nothing uncommitted, and nothing is open.

At the end of the session, check the work against the brief's Problem and Solution.`;
}
