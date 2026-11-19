// What Grok is told about the session brief. The Claude plugin puts the same procedure in the system
// prompt (hooks/register.ts). Grok has no prompt.compose hook, so the Grok hook writes this file and
// attaches it to the first tool call of each turn (and again after a compaction).

/** What to tell the agent when this session was not started inside a git repo. */
export function outsideRepoNote(cwd) {
  const folder = cwd || 'this folder';
  return `session-rail: No brief for ${folder}. It is not a git repo. This session's desk reads only that folder, so a brief written in a project inside it does not show on the Plan tab. Start the session in the repo, write the brief there, then render this session's desk (desk.mjs --frame 72 24 --tab plan, with this session's cwd, host and session id) and read the frame before saying the plan is in the Plan tab.`;
}

/** The Plan tab's own line for that same case. The folder is already shortened for the pane. */
export function deskOutsideNote(folder) {
  const where = folder || 'this folder';
  return `No brief here. This session is in ${where}, which is not a git repo. The Plan tab shows the brief of the repo the session was started in.`;
}

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

Work the brief out with the person before editing any code. Don't wait to be asked: as soon as the discussion makes the problem and the solution clear, tell the person it's scoped out and write the brief, then summarise it in a few lines. This brief shows on the desk's Plan tab only when the session was started in this repo. Render this session's desk and read the frame before you say the plan is there: desk.mjs --frame 72 24 --tab plan, with this session's --cwd, --host and --session. If that frame does not show this brief, say what it shows. A plan.md from plan mode is a different file. When it is newer than the brief, the Plan tab shows that file and has no Approve button, so do not write one in place of the brief. Keep filling it in as the discussion goes on (design, mockups, engineering chunks). Write it in this shape:

${SHAPE}

Keep the solution and the outline the simplest way to reach the goal. search_replace, write, and a shell command that writes a file in the checkout are refused on any other file until the brief has a problem, a solution and at least one chunk, and the person has approved it. A read-only command such as git log still runs. When it's complete, run the approach review (${review}), work its findings into the brief, then ask them to review it and press Approve in the desk's Plan tab (or type /approve-brief). Never approve it yourself or write its approval file.

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

Before merging, which waits for the person to say so: run /review over the whole branch (against the default branch) and commit and push its fixes. End that review's final message with a \`\`\`json block {"findings":[{"summary":"...","short_summary":"...","file":"...","line":1,"outcome":"fixed"|"skipped"|"no_change_needed"}]}. Then run ${review} --final so it checks what the fixer did. Apply what it finds, commit and push, and run it with --final once more to check them, at most two rounds. If something is still open after that, list it in the PR and ask the person instead of looping. The plugin refuses gh pr merge until the code review has run since the last chunk's review, the final approach review has run after it on the last commit with nothing uncommitted, and nothing is open. After each saved approach review and code review it posts the commit status session-rail/review from that record. success is only a clear gate. Do not post that status yourself.

At the end of the session, check the work against the brief's Problem and Solution.`;
}
