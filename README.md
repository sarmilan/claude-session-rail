# claude-session-rail

A side panel for Claude Code in iTerm2, like the one in the Claude desktop app.

When you start `claude`, a narrow pane opens on the right. It shows what Claude is working with and what's running. Type `/rail` to hide it or bring it back.

```
┌─ claude ──────────────────────────┬─ rail ───────────────────────────┐
│                                   │ Environment                      │
│  > fix the login redirect         │ ▭  my-macbook                    │
│                                   │ ▢  my-app · ~/code               │
│  ● Reading src/auth/login.ts      │ ⎇  feature/login       3 changed │
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

- **Environment:** your computer, repo, and branch
- **Context:** how full Claude's context window is
- **Connectors:** your MCP servers and whether they're connected
- **Changes:** your open pull requests in this repo
- **Background tasks:** commands and subagents Claude is running in the background. Open one to see its output.
- **Active agents:** every Claude session running on your Mac, in the terminal or the desktop app

Click a row, or use the arrow keys and Enter, to open it. Pull requests open in the browser, tasks show their output, and agents give you their resume command.

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

Say `y` to add the marketplace. Start a new `claude` session in iTerm2 and the rail opens on the right.

If macOS asks whether to allow controlling iTerm2, allow it. That's how the rail opens its pane.

## Use

- The rail opens by itself when you start `claude`.
- `/rail` hides or shows it.
- It closes when you quit Claude.
- Keys: `↑` `↓` to move, `Enter` to open, `Esc` to go back, `c` to change creature, `[` `]` to preview its growth stages (for 10 seconds), `q` to close the rail.
- A little pixel creature wanders along the bottom: Claudey the snail, a turtle or a crab. It walks through its own habitat (woodland for the snail, a pond for the turtle, a beach for the crab) with plants swaying gently behind it in iTerm2. It hurries while Claude is busy and falls asleep when things go quiet. Your pick is remembered.
- The creature grows as the session's context window fills: hatchling until the session's first reply, then juvenile, adult from 40% (faster, hopping), and heavy from 60% (bigger, shaking, fuming). Each creature has a drawing for each stage, from a pale little hatchling to a spiked, scowling heavy.

## How it works

The rail only reads files Claude Code already keeps on your Mac: the list of running sessions, the session's conversation log (for context and background tasks), and the output of each background task. It also asks `git`, `gh`, and `claude mcp list` for the rest.

It has three parts:

1. **The rail** (`bin/rail.mjs`) draws the panel in the terminal. It's plain Node with no dependencies.
2. **The pane opener** (`bin/pane.mjs`) uses iTerm2's AppleScript support to split Claude's pane, run the rail on the right, and hand focus back to Claude.
3. **The plugin** (`hooks/register.ts`) opens the rail when a session starts, adds the `/rail` command, and closes the rail when the session ends.

## Good to know

- It only works in iTerm2 on a Mac. Elsewhere it stays out of the way.
- Context shows tokens and the model, but not cost.
- It reads Claude Code's own files, which can change between Claude Code versions.

## Uninstall

```
claude plugin uninstall session-rail
```

## License

MIT
