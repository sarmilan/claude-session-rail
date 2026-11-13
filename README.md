# claude-session-rail

Side panels for Claude Code in iTerm2, like the ones in the Claude desktop app.

When you start `claude`, two panes open on the right:

- **The rail**, a narrow pane that shows what Claude is working with and what's running. `/rail` hides it or brings it back.
- **The desk**, a wider pane between Claude and the rail, with tabs for the plan, the diff, and the branch's reviews. It opens on Plan, which shows the latest merged PRs and commits until there's a plan. `/desk` hides it or brings it back.

If you have a `/start` command of your own, it runs as soon as the session starts.

```
┌─ claude ──────────────────────────┬─ rail ───────────────────────────┐
│                                   │ ──────────────────────────────── │
│                                   │  Session   Git                 ⇥ │
│                                   │ ━━━━━━━━━─────────────────────── │
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
│                                   │ Context ▾          33% ▰▰▰▱▱▱▱▱  │
│                                   │   Model    Opus 4.6              │
│                                   │   Tokens   66k / 200k            │
│                                   │ ──────────────────────────────── │
│                                   │ Connectors ▸         4 connected │
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

The rail has two tabs: **Session**, what Claude is doing, and **Git**, where all your work stands. `Tab` or `]` goes to the next tab, `Shift-Tab` or `[` to the previous one, or click one. Each rail remembers its own tab.

### Session

- **Sessions:** every Claude session on your Mac, this one first (▸), then the ones that need you. Each shows its brief's title (or its branch), whether it's busy, waiting for you, blocked (the brief gate just held an edit) or idle, and underneath, its repo, branch and what it's doing right now. Every rail shows the same list.
- **Environment:** your computer, account, repo, and branch, with the lines added and removed since the branch forked from the default branch (committed plus uncommitted; untracked files are not counted)
- **Context:** how full the context window is. It starts open, with the model, the token count, and the usage windows.
- **Connectors:** your MCP servers and whether they're connected
- **Now:** who is doing what this second, and for how long:
  - **Claude:** thinking (with the model), the tool it's running and on what, waiting on its subagents, or waiting for you
  - nested under it, its **subagents** and **background tasks**. Every subagent gets a name and a colour when it starts (Wren, Otto, Juno… from `bin/names.mjs`), and its row shows what it was asked and the call it's running now. Its task and its completion notification read `Name: description`, so you can tell who a response is from. Open a background task or agent to see its output.
  - the **Desk** while it runs an approach review, and the **Gate** when it has just held an edit because the brief isn't approved
- **Just now:** the last few finished tool calls, with ✔ or ✗ (a subagent's start with its name, in its colour), the session's finished background tasks, and `⟲ compacted after <branch>` for an hour after the session compacted itself

### Git

```
 ───────────────────────────────────
  Session   Git                    ⇥
 ──────────━━━━━────────────────────
 my-app · main                  ↻ 4s
 Worktrees 3
 ▸ ● my-app-login         fix/42-lo…
     ↑2 · 3 changed · #42 ✗
   ○ my-app        feature/51-dark-…
     ↑4 ↓1 · clean · #51 ◌
   ○ old-spike     feature/38-cache
     ✓ merged · clean
 This branch fix/42-login…  +42 −7
 ◌ 3 uncommitted
 ● 9f2c1ab Stop the redirect loop 2m
 ◆ 11b48b1 Merge pull #40   main 3h
 PR #42 · open
 ✗ lint                      failing
 ✓ test
 Pull requests
 ⑂ Fix login redirect loop         ⋯
```

- **Worktrees:** every checkout of the repo, this one first (▸). Each card shows its branch (or the commit it's detached at), how far it is ahead (↑) of and behind (↓) the default branch, or ✓ merged once its work is in, how many files are uncommitted, and its pull request with a badge for its checks: ✓ passing, ✗ failing, ◌ running. Open a card to go to the Claude session working in it (or start one there), open its pull request or its failing check, or copy its branch name.
- **This branch:** the lines added and removed, uncommitted files, and the branch's commits since it forked, down to the default-branch commit it started from (◆).
- **PR:** this branch's pull request and each of its checks, failing first. Open a check to see its run.
- **Pull requests:** your open pull requests in this repo.

Checks come from GitHub through `gh`; a repo without CI shows "No checks". Only your own pull requests are listed, so a worktree on someone else's shows no badge. This worktree's commits refresh every 5 seconds; the other cards and the pull requests every minute, when you switch to the tab, and on `r`.

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
- **Review:** the branch's reviews and what became of each finding (see *Reviews* below).
  - **Approach:** a staff-engineer review in a separate, headless Claude. It reads the brief, each chunk's summary and files, and how much each file changed. It says whether this is the simplest, most elegant and least costly way to the goal: on track, a simpler path exists, or off the goal. Findings are things like a simpler design, work beyond the goal, avoidable cost, or part of the goal not covered.
  - **Code review:** the newest `/code-review`, finding by finding, with its file and line. `Enter` jumps to that line in the diff.
  - Each finding shows ● open, ✓ applied or ✗ declined (✓ fixed, ✓ no change or ✓ skipped for code), and a declined one shows the reason. Older runs are listed one line each. Reviews are saved per branch inside `.git`.

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
- Claude works through the chunks in order. As each one is finished, it checks it against the plan (running the tests), adds a short `Done:` summary and its `Files:`, runs the approach review and applies its findings, runs what it built once for real, commits it on its own and pushes, opening the pull request after the first chunk, then moves straight on to the next chunk unless something needs your decision.
- When a branch is done the session compacts itself, so the next issue starts lean. It happens once the session leaves a branch (back to main, or onto the next issue's branch) whose brief has a finished chunk and whose work is merged into the default branch, after Claude's turn ends. The summary keeps the board, how you like work done, open issues and what's next, and shrinks the finished branch to a line. Leaving an unmerged branch doesn't compact. Turn it off in the rail's settings.
- The plan and every chunk get an approach review, and the whole branch a code review before it's merged (see *Reviews* below).

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
| `Enter` | jump to a code finding's line (Review) |
| `x` | cancel a running review |
| `q` | close the desk |

An approach review takes under a minute and uses your Claude account like any other `claude -p` run.

### Reviews

Two reviews, each where it pays off:

- **The approach review** (`review_approach`, a staff engineer in a headless Claude, under a minute) runs often:
  - **On the plan:** once the brief is complete, before you're asked to approve it. That's the cheapest time to change course.
  - **After each chunk:** once its `Done:` line is in. Claude applies each finding and calls the tool once more to check them, at most two rounds. Each review marks the earlier findings **applied**, **declined** (a reason not to that the reviewer accepted) or still **open**.
  - Then Claude runs what the chunk built once for real, not only its tests, before committing.
- **The code review** (`/code-review --fix`) runs once, **before merging** (still only when you say so), over the whole branch, and its fixes are committed. Then `review_approach` with `final: true` gives it a staff-engineer pass: it checks that claimed fixes landed, and accepts each skip or "no change" or reopens it. Claude applies what it finds, commits, and calls it once more to check, at most two rounds. Anything still open after that is listed in the PR, and Claude asks you instead of looping.
  - The plugin notices the Skill tool running `/code-review` (or you typing it), gives the run a token, and asks it to end with its findings as a JSON block that carries the token. Then it records the answer that does, whether the review ran in a forked agent or inline.
- **The gate:** the plugin refuses Claude's `gh pr merge` until the code review has run since the last chunk's review, the final approach review has run after it on the last commit with nothing uncommitted, and nothing is open. Claude is told what's missing. Commits aren't gated.
- **The PR's Progress checklist** notes each chunk's approach review.

The gate only covers commands Claude runs, so you can always merge yourself. A `/code-review` you type yourself counts too. **Run review** in the desk runs an approach review on demand.

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

The same plugin does this for Grok. In a terminal:

```
grok plugin marketplace add <this folder>
grok plugin install <this folder> --trust
```

Start a new `grok` in iTerm2. The desk and the rail open on the right, and the brief, the reviews and **+ new** work the same way. Plan shows the branch brief, and before there is one it shows the `plan.md` plan mode writes in the Grok session, the same way Claude's plan file shows up. The pet follows the activity feed, since a Grok session file never says busy. `/rail` and `/desk` are in the slash menu, and the two panels use Grok's colours. A session that is already open does not pick the plugin up until you start another one. The install copies this folder; refresh it with `grok plugin uninstall session-rail --confirm`, then the install again.

If macOS asks whether to allow controlling iTerm2, allow it. That's how the panels open their panes and how the rail switches between sessions.

## Use

- The rail and the desk open by themselves when you start `claude`.
- `/rail` hides or shows the rail, and `/desk` the desk.
- They close when you quit Claude.
- Keys: `↑` `↓` to move, `Enter` to open, `Esc` to go back, `c` to change creature, `q` to close the rail.
- **⚙ settings**, in the rail's bottom-right corner, opens three rows under the creature: `←` `→` on **Font size** makes the Claude pane, the desk and the rail bigger or smaller together (`Enter` for Reset), `←` `→` on **Pet** picks the creature, and `←` `→` on **Auto-compact** turns auto-compaction off or on. The font size is remembered and comes back with the next session. It works by switching the panes to iTerm profiles it generates (`session-rail 15pt` and so on), which show up in iTerm's Profiles menu.
- A little pixel creature wanders along the bottom: a snail, a turtle (with a bright green shell, warm amber when heavy) or a crab. It walks through its own habitat (woodland for the snail, a pond for the turtle, a beach for the crab) on speckled ground (soil, mud or sand), with plants swaying gently behind it in iTerm2. Sand puffs under the crab, and the reeds bend when the turtle hops. It hurries while the agent is busy, looks left and fidgets while it is waiting for you, and falls asleep only after a real lull. Your pick is remembered.
- The strip is the branch's road, left to right: the creature paces around a spot that moves right as the brief's chunks get Done, from the left edge before approval to the right edge when all of them are, and walks briskly to its new spot after each one. Each Done chunk leaves a marker behind it (a mushroom, a lily pad or a shell) and the creature hops with a gold sparkle. With no brief it wanders the whole strip.
- Each running subagent brings a visitor, a bee, butterfly, dragonfly or ladybird in turn, tinted with that subagent's colour (up to 4, and a `+n` when more are running). They flutter around the creature, settle when things are quiet, scatter when a tool fails, and fly off when their subagent finishes.
- A little one, a baby of the creature, trails behind it for each running background command (up to 3, then a `+n`). Babies tuck in when it sleeps, pile up while the brief is unapproved, and hide behind it when it flinches. A failed tool makes it flinch, pop a red puff, and stay drooped until the next tool succeeds. While the brief is not approved yet it stands still with a yellow `?` over its head.
- The creature grows as the branch heads toward its compaction: a hatchling until the branch's brief is approved, then juvenile, adult after the first Done chunk (faster, hopping), and heavy once every chunk is Done (bigger, shaking, a gold mark: merge it and let it compact). After the compaction the next branch starts again with a hatchling. Each creature has a drawing for each stage, from a pale little hatchling to a spiked, scowling heavy. Now and then it fidgets: the snail stretches, the turtle peeks, the crab snaps a claw. Waking up is a little stretch.

## How it works

The rail only reads files Claude Code already keeps on your Mac: the list of running sessions, the session's conversation log (for context and background tasks), and the output of each background task. It also asks `git` (worktrees, ahead/behind, commits), `gh` (your pull requests and their checks, in one call), and `claude mcp list` for the rest.

It has these parts:

1. **The rail** (`bin/rail.mjs`) draws the narrow panel in the terminal. It's plain Node with no dependencies.
2. **The desk** (`bin/desk.mjs`) draws the wider panel. It reads the branch's brief (`bin/brief.mjs`), finds the plan file in the session's conversation log, asks `git` for the diff and `gh` for the board's Todo issues. Its reviewer (`bin/reviewer.mjs`) runs the approach review through `claude -p` with a JSON schema for the findings, read-only tools, no MCP servers and no saved session, and keeps each branch's reviews in `.git/session-rail/reviews/`. Claude runs the same reviewer through its CLI (`node bin/reviewer.mjs --run [--final] [--notes …]`), which the plugin's `review_approach` tool calls. `bin/cadence.mjs` holds the rules: finding statuses, what's open, and when a merge must wait.
3. **The pane opener** (`bin/pane.mjs`) uses iTerm2's AppleScript support to fill the screen, split Claude's pane, run each panel (desk next to Claude, rail on the far right), size them in one pass, and hand focus back to Claude. The rail also uses it to bring another session's window to the front and to open the window for a new session.
4. **The plugin** (`hooks/register.ts`) keeps a live record of what the session is doing (`hooks/activity.ts`: turns, every tool call, subagents with the names it gave them at `agent.spawn`, the brief gate) in `~/.claude/session-rail/activity/<session id>.json`, which the rail reads every second; the desk adds its running review beside it. It also opens both panels when a session starts, adds `/rail`, `/desk` and `/approve-brief`, and closes them when the session ends. On a feature branch it adds the brief's instructions to Claude's system prompt, refuses code edits until the brief is approved, watches for the approval (`hooks/goahead.ts`) to tell Claude to start, compacts the session after a finished, merged branch (`hooks/compact.ts`), serves `review_approach`, records each `/code-review` report in the branch's reviews, and refuses `gh pr merge` until the final reviews are in. Settings shared by the rail and the hooks (font size, auto-compact) live in `~/.claude/session-rail/settings.json`; each rail keeps its open tab in `<session id>.rail.json` beside the session's activity file.

## Good to know

- It only works in iTerm2 on a Mac. Elsewhere it stays out of the way.
- When a session starts, the iTerm window fills the screen (without switching to macOS full screen). The desk takes 28% of the width, the rail 18.5%, and Claude keeps the rest. `/rail` and `/desk` take their share from Claude's pane, and the window never grows.
- A second Claude login (`CLAUDE_CONFIG_DIR=~/.claude-work claude`, or any `~/.claude-<name>`) works too: the rail lists its sessions and reads its context, plan, background tasks, account and rate limits from that dir. The panes, the pet and the settings stay shared.
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
