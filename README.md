# claude-session-rail

Side panels for Claude Code in iTerm2, like the ones in the Claude desktop app.

When you start `claude`, two panes open on the right:

- **The rail**, a narrow pane that shows what Claude is working with and what's running. `/rail` hides it or brings it back.
- **The desk**, a wider pane between Claude and the rail, with tabs for the plan, the diff, and a code review. It opens on Plan, which shows the latest merged PRs and commits until there's a plan. `/desk` hides it or brings it back.

If you have a `/start` command of your own, it runs as soon as the session starts.

```
┌─ claude ──────────────────────────┬─ rail ───────────────────────────┐
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
│                                   │ Background tasks                 │
│                                   │ ◇ Run test suite          2m  ■  │
│                                   │ ◇ 6 finished                     │
│                                   │ ──────────────────────────────── │
│                                   │ Active agents  2                 │
│                                   │ ● fix-login-redirect   busy  cli │
│                                   │   my-app · 4s · here             │
│                                   │ ○ Write release notes  idle  app │
│                                   │   docs · 12m                     │
│                                   │                                  │
│  >                                │ ↑↓ move · ⏎ open · q quit        │
└───────────────────────────────────┴──────────────────────────────────┘
```

## What it shows

- **Environment:** your computer, repo, and branch, with the lines added and removed since the branch forked from the default branch (committed plus uncommitted; untracked files are not counted)
- **Context:** how full Claude's context window is
- **Connectors:** your MCP servers and whether they're connected
- **Changes:** your open pull requests in this repo
- **Background tasks:** commands and subagents Claude is running in the background. Open one to see its output.
- **Active agents:** every Claude session running on your Mac, in the terminal or the desktop app

Click a row, or use the arrow keys and Enter, to open it. Pull requests open in the browser, tasks show their output, and agents give you their resume command.

## The desk

```
┌─ desk ───────────────────────────────────────────────────────────────────────┐
│  Plan   Diff +134 −6   Review 2                               follows Claude │
│ ──────────────────────────────────────────────────────────────────────────── │
│ 4 files since the branch forked  +134 −6                                     │
│                                                                              │
│ new bin/desk.mjs                                                     +37 −0  │
│     bin/rail.mjs                                                      +8 −2  │
│     bin/sources.mjs                                                  +87 −2  │
│     README.md                                                         +2 −2  │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Plan:** the plan Claude writes in plan mode, shown as it's written.
- **Diff:** every file changed since the branch forked from the default branch, the same base as the rail's `+N −N`. Untracked files are included, marked `new`. Open a file to see its diff.
- **Review:** a code review of those changes by a separate, headless Claude that can only read the code. It reports real problems only (bugs, crashes, security issues, code that won't run), each with its file and line. Open a finding to jump to that line in the diff, or send findings to Claude to fix.

The desk follows Claude: a new or changed plan brings up Plan, changed files bring up Diff, and a finished review brings up Review. Pick a tab yourself and it stops following until you press `a`.

Keys:

| Key | Does |
|---|---|
| `Tab`, `1` `2` `3`, or click | switch tabs |
| `a` | follow Claude again |
| `↑` `↓`, `j` `k`, mouse wheel | move or scroll |
| `Space` / `b`, `PgDn` / `PgUp`, `g` / `G` | page, top, bottom |
| `Enter` | open a file (Diff) or go to a finding's line (Review) |
| `n` `p`, `Esc` | next/previous file, back to the list |
| `r` | review now (Review), refresh (other tabs) |
| `Space`, `s` | mark findings, send the marked ones (or the selected one) to Claude |
| `i` | review automatically each time Claude finishes a turn (off by default) |
| `S` | send automatic reviews' findings straight to Claude (off by default) |
| `x` | cancel a running review |
| `q` | close the desk |

A review takes about a minute and uses your Claude account like any other `claude -p` run.

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
- Keys: `↑` `↓` to move, `Enter` to open, `Esc` to go back, `c` to change creature, `[` `]` to preview its growth stages (for 10 seconds), `q` to close the rail.
- A little pixel creature wanders along the bottom: Claudey the snail, a turtle or a crab. It walks through its own habitat (woodland for the snail, a pond for the turtle, a beach for the crab) with plants swaying gently behind it in iTerm2. It hurries while Claude is busy and falls asleep when things go quiet. Your pick is remembered.
- The creature grows as the session's context window fills: hatchling until the session's first reply, then juvenile, adult from 40% (faster, hopping), and heavy from 60% (bigger, shaking, fuming). Each creature has a drawing for each stage, from a pale little hatchling to a spiked, scowling heavy.

## How it works

The rail only reads files Claude Code already keeps on your Mac: the list of running sessions, the session's conversation log (for context and background tasks), and the output of each background task. It also asks `git`, `gh`, and `claude mcp list` for the rest.

It has these parts:

1. **The rail** (`bin/rail.mjs`) draws the narrow panel in the terminal. It's plain Node with no dependencies.
2. **The desk** (`bin/desk.mjs`) draws the wider panel. It finds the plan file in the session's conversation log and asks `git` for the diff. Its reviewer (`bin/reviewer.mjs`) runs `claude -p` with read-only tools, no MCP servers, and no saved session. It notices Claude finishing a turn from Claude's own session file.
3. **The pane opener** (`bin/pane.mjs`) uses iTerm2's AppleScript support to fill the screen, split Claude's pane, run each panel (desk next to Claude, rail on the far right), size them in one pass, and hand focus back to Claude.
4. **The plugin** (`hooks/register.ts`) opens both panels when a session starts, adds `/rail` and `/desk`, and closes them when the session ends.

## Good to know

- It only works in iTerm2 on a Mac. Elsewhere it stays out of the way.
- When a session starts, the iTerm window fills the screen (without switching to macOS full screen). The desk takes 28% of the width, the rail 18.5%, and Claude keeps the rest. `/rail` and `/desk` take their share from Claude's pane, and the window never grows.
- Context shows tokens and the model, but not cost.
- It reads Claude Code's own files, which can change between Claude Code versions.

## Uninstall

```
claude plugin uninstall session-rail
```

## License

MIT
