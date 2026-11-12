# claude-session-rail

Side panels for Claude Code in iTerm2, like the ones in the Claude desktop app.

When you start `claude`, two panes open on the right:

- **The rail**, a narrow pane that shows what Claude is working with and what's running. `/rail` hides it or brings it back.
- **The desk**, a wider pane between Claude and the rail, with tabs for the plan, the diff, and a code review. It opens on Plan, which shows the latest merged PRs and commits until there's a plan. `/desk` hides it or brings it back.

If you have a `/start` command of your own, it runs as soon as the session starts.

```
┌─ claude ──────────────────────────┬─ rail ───────────────────────────┐
│                                   │ Sessions 3                 + new │
│                                   │ ▸ ◉ Fix login redirect loop busy │
│                                   │     my-app · fix/42 · Edit redi… │
│                                   │   ◆ Dark mode toggle     waiting │
│                                   │     my-app · feature/51 · waiti… │
│                                   │ ──────────────────────────────── │
│                                   │ Environment                      │
│  > fix the login redirect         │ ▭  my-macbook                    │
│                                   │ ▢  my-app · ~/code               │
│  ● Reading src/auth/login.ts      │ ⎇  feature/l… +42 −7 · 3 changed │
│  ● Editing src/auth/redirect.ts   │ ◌  Remote Control  /remote-cont… │
│                                   │ ──────────────────────────────── │
│                                   │ Context ▸          33% ▰▰▰▱▱▱▱▱  │
│                                   │ ──────────────────────────────── │
│                                   │ Connectors ▸         4 connected │
│                                   │ ──────────────────────────────── │
│                                   │ Changes                          │
│                                   │ ⑂ Fix login redirect loop      ⋯ │
│                                   │   my-app #42                     │
│                                   │ ──────────────────────────────── │
│                                   │ Now                              │
│                                   │ ◉ Claude  Edit src/auth/redi… 4s │
│                                   │   ├ ◆ Explore: find callers  38s │
│                                   │   └ ◇ Run test suite          2m │
│                                   │ ◉ Desk  approach review      40s │
│                                   │ ──────────────────────────────── │
│                                   │ Just now                         │
│                                   │ ✔ Read src/auth/login.ts      6s │
│                                   │ ✗ Bash npm test              12s │
│                                   │ ──────────────────────────────── │
│  >                                │                                  │
└───────────────────────────────────┴──────────────────────────────────┘
```

## What it shows

- **Sessions:** every Claude session on your Mac, this one first (▸), then the ones that need you. Each shows its brief's title (or its branch), whether it's busy, waiting for you, blocked (the brief gate just held an edit) or idle, and underneath, its repo, branch and what it's doing right now. Every rail shows the same list.
- **Environment:** your computer, repo, and branch, with the lines added and removed since the branch forked from the default branch (committed plus uncommitted; untracked files are not counted)
- **Context:** how full Claude's context window is
- **Connectors:** your MCP servers and whether they're connected
- **Changes:** your open pull requests in this repo
- **Now:** who is doing what this second, and for how long:
  - **Claude:** thinking (with the model), the tool it's running and on what, waiting on its subagents, or waiting for you
  - nested under it, its **subagents** (with what one is doing, when only one runs) and **background tasks**. Open a background task to see its output.
  - the **Desk** while it runs an approach review, and the **Gate** when it has just held an edit because the brief isn't approved
- **Just now:** the last few finished tool calls, with ✔ or ✗, the session's finished background tasks, and `⟲ compacted after <branch>` for an hour after the session compacted itself

Click a row, or use the arrow keys and Enter, to open it. A session jumps to its iTerm window (a session in the Claude app gives you its details instead), pull requests open in the browser, and tasks show their output.

### Working on several things at once

**+ new**, on the Sessions heading, starts another session without touching this one. Type the problem on the rail's bottom line and press Enter (Esc cancels). The rail adds a git worktree of the repo at the latest `main`, beside the repo in `<repo>.worktrees/<name>`, opens a new iTerm window there, at the same size and place as this one, and runs `claude "/start <your problem>"`, so `/start` files the issue and makes the branch inside that worktree. Each session has its own checkout, so two sessions never edit the same files, and each window gets its own Claude │ desk │ rail. With one tab per window iTerm shows no tab bar: the Sessions list is how you move between them.

## The desk

```
┌─ desk ───────────────────────────────────────────────────────────────────────┐
│  Plan   Diff +134 −6   Review 2                                              │
│ ──────────────────────────────────────────────────────────────────────────── │
│ 4 files since the branch forked  +134 −6                                     │
│                                                                              │
│ Chunk 1: Show the date and time in the header                       +95 −2   │
│ ✔ Added date and time state, pulled from the clock API once a minute         │
│       src/header.tsx                                                 +58 −2  │
│   new src/useClock.ts                                                +37 −0  │
│                                                                              │
│ Not in a chunk yet                                                  +39 −4   │
│       README.md                                                       +2 −2  │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Plan:** the branch's **brief** (see below), live, with an **Approve** button when it's ready. Until the branch has a brief, and on `main`, it lists the **Todo** issues on the repo's GitHub project board first, so you can pick one up, then the plan Claude writes in plan mode, or the latest merged PRs and commits.
- **Diff:** every file changed since the branch forked from the default branch, the same base as the rail's `+N −N`, grouped under the brief's chunks with each chunk's summary. Untracked files are included, marked `new`. Open a file to see its diff.
- **Review:** a staff-engineer review of the approach, run in a separate, headless Claude. It reads the brief, each chunk's summary and files, and how much each file changed, and says whether this is the simplest, most elegant and least costly way to the goal: on track, a simpler path exists, or off the goal, with findings such as a simpler design, work beyond the goal, avoidable cost, or part of the goal not covered. It doesn't review code line by line; that's the code review in `/end`. Click **accept** on a finding, or **Accept all**, to hand it to Claude, who acts on it and updates the brief. Reviews are saved per branch inside `.git`.

The desk opens on Plan and stays on the tab you pick.

### The session brief

On any branch but `main` or `master`, Claude keeps a brief for the branch: what the session sets out to do, and what the work is checked against at the end. It lives inside `.git` (`.git/session-rail/briefs/`), so it's never committed.

```
# <title>
## Problem       Currently it's A; we need B to solve A
## Solution      As an X, I should be able to Y so I can Z
## Design        UI/UX decisions
## Mockups       ASCII mockups
## Engineering
### Chunk 1: <name>
<outline>
Done: <summary>             ← added as each chunk is finished
Files: src/a.ts, src/b.ts
```

- As you talk the problem through, Claude says when it's scoped out and writes the brief. You don't need to ask.
- Claude can't edit code (Edit, Write, NotebookEdit) until the brief has a problem, a solution and at least one chunk, and you've pressed **Approve** in the Plan tab (or `A`, or `/approve-brief` when the desk isn't open). Writes Claude makes through the shell aren't covered.
- Approving is the go-ahead: within a couple of seconds the plugin sends Claude a message to start on chunk 1, so you never have to type "go". It waits until Claude is idle and doesn't type over what you're writing.
- Once approved, nothing blocks again. If the problem, solution or outline changes later, the Plan tab says "changed since" and offers **Approve again**, which tells Claude the change is approved so it carries on.
- Claude works through the chunks in order. As each one is finished, it reviews it against the plan (running the tests), adds a short `Done:` summary and its `Files:`, commits it on its own and pushes, opening the pull request after the first chunk, then moves straight on to the next chunk unless something needs your decision.
- When a branch is done the session compacts itself, so the next issue starts lean. It happens once the session leaves a branch (back to main, or onto the next issue's branch) whose brief has a finished chunk and whose work is merged into the default branch, after Claude's turn ends. The summary keeps the board, how you like work done, open issues and what's next, and shrinks the finished branch to a line. Leaving an unmerged branch doesn't compact. Turn it off in the rail's settings.
- The approach review runs by itself at milestones: when a chunk gets its `Done:` line, and when the plan changes after approval, once the brief has been still for 20 seconds. **Run review** runs it any time, before approval too. Each run is one `claude -p` call.

Keys:

| Key | Does |
|---|---|
| `Tab` / `Shift-Tab`, `1` `2` `3`, or click | switch tabs |
| `↑` `↓`, `j` `k`, mouse wheel | move or scroll |
| `Space` / `b`, `PgDn` / `PgUp`, `g` / `G` | page, top, bottom |
| `Enter` | open a file (Diff) |
| `n` `p`, `Esc` | next/previous file, back to the list |
| `A` | approve the brief (Plan) |
| `r` | run a review (Review), refresh (other tabs) |
| `y`, `A` | accept the selected finding, accept all (Review) |
| `x` | cancel a running review |
| `q` | close the desk |

A review takes under a minute and uses your Claude account like any other `claude -p` run. Nothing is sent to Claude until you accept it.

## What you need

- A Mac with iTerm2
- Claude Code 2.1.319 or newer
- Node.js 18 or newer
- The GitHub CLI (`gh`), for the pull request list (optional)

## Install

In Claude Code, run:

```
/plugin install session-rail --marketplace sarmilan/claude-session-rail
```

Say `y` to add the marketplace. Start a new `claude` session in iTerm2 and the desk and the rail open on the right.

If macOS asks whether to allow controlling iTerm2, allow it. That's how the panels open their panes, and how the desk sends review findings to Claude.

## Use

- The rail and the desk open by themselves when you start `claude`.
- `/rail` hides or shows the rail, and `/desk` the desk.
- They close when you quit Claude.
- Keys: `↑` `↓` to move, `Enter` to open, `Esc` to go back, `c` to change creature, `q` to close the rail.
- **⚙ settings**, in the rail's bottom-right corner, opens three rows under the creature: `←` `→` on **Font size** makes the Claude pane, the desk and the rail bigger or smaller together (`Enter` for Reset), `←` `→` on **Pet** picks the creature, and `←` `→` on **Auto-compact** turns auto-compaction off or on. The font size is remembered and comes back with the next session. It works by switching the panes to iTerm profiles it generates (`session-rail 15pt` and so on), which show up in iTerm's Profiles menu.
- A little pixel creature wanders along the bottom: Claudey the snail, a turtle or a crab. It walks through its own habitat (woodland for the snail, a pond for the turtle, a beach for the crab) with plants swaying gently behind it in iTerm2. It hurries while Claude is busy and falls asleep when things go quiet. Your pick is remembered.
- The creature grows as the branch heads toward its compaction: a hatchling until the branch's brief is approved, then juvenile, adult after the first Done chunk (faster, hopping), and heavy once every chunk is Done (bigger, shaking, fuming: merge it and let it compact). After the compaction the next branch starts again with a hatchling. Each creature has a drawing for each stage, from a pale little hatchling to a spiked, scowling heavy.

## How it works

The rail only reads files Claude Code already keeps on your Mac: the list of running sessions, the session's conversation log (for context and background tasks), and the output of each background task. It also asks `git`, `gh`, and `claude mcp list` for the rest.

It has these parts:

1. **The rail** (`bin/rail.mjs`) draws the narrow panel in the terminal. It's plain Node with no dependencies.
2. **The desk** (`bin/desk.mjs`) draws the wider panel. It reads the branch's brief (`bin/brief.mjs`), finds the plan file in the session's conversation log, asks `git` for the diff and `gh` for the board's Todo issues. Its reviewer (`bin/reviewer.mjs`) runs the approach review through `claude -p` with a JSON schema for the findings, read-only tools, no MCP servers and no saved session, and keeps each branch's reviews in `.git/session-rail/reviews/`.
3. **The pane opener** (`bin/pane.mjs`) uses iTerm2's AppleScript support to fill the screen, split Claude's pane, run each panel (desk next to Claude, rail on the far right), size them in one pass, and hand focus back to Claude. The rail also uses it to bring another session's window to the front and to open the window for a new session.
4. **The plugin** (`hooks/register.ts`) keeps a live record of what the session is doing (`hooks/activity.ts`: turns, every tool call, subagents, the brief gate) in `~/.claude/session-rail/activity/<session id>.json`, which the rail reads every second; the desk adds its running review beside it. It also opens both panels when a session starts, adds `/rail`, `/desk` and `/approve-brief`, and closes them when the session ends. On a feature branch it adds the brief's instructions to Claude's system prompt, refuses code edits until the brief is approved, watches for the approval (`hooks/goahead.ts`) to tell Claude to start, and compacts the session after a finished, merged branch (`hooks/compact.ts`). Settings shared by the rail and the hooks (font size, auto-compact) live in `~/.claude/session-rail/settings.json`.

## Good to know

- It only works in iTerm2 on a Mac. Elsewhere it stays out of the way.
- When a session starts, the iTerm window fills the screen (without switching to macOS full screen). The desk takes 28% of the width, the rail 18.5%, and Claude keeps the rest. `/rail` and `/desk` take their share from Claude's pane, and the window never grows.
- Context shows tokens and the model, but not cost.
- It reads Claude Code's own files, which can change between Claude Code versions.
- Worktrees made by **+ new** stay after their branch is merged; remove one with `git worktree remove <path>`. Claude keeps a separate project memory for each worktree, since it's a different folder.
- Every session that loads the plugin, headless `claude -p` runs included, writes a small activity file to `~/.claude/session-rail/activity/`. Nothing cleans them up yet; they're safe to delete.

## Uninstall

```
claude plugin uninstall session-rail
```

## License

MIT
