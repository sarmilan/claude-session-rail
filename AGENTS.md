# AGENTS.md

Short map for a fresh Claude or Grok session in this repo. Read this for layout, install, and how to test. Deeper hook and architecture notes are in [CLAUDE.md](CLAUDE.md). Behaviour, the product brief, and the pets are in [README.md](README.md) and [docs/pets.md](docs/pets.md). Keep the brief flow and the pets as those docs describe them.

## Layout

Plain Node 18+ ESM in `bin/`. Zero npm dependencies. `hooks/` has no Node APIs; it uses the host's `$.process` and `$.plugin.root`.

- `bin/rail.mjs` draws the rail. `bin/desk.mjs` draws Plan, Diff, and Review.
- `bin/stop-hook.mjs` is the Stop test gate for Claude and Grok. The rules are in `bin/stopgate.mjs`.
- `hooks/register.ts` is Claude's plugin. `bin/grok-hook.mjs` is Grok's.
- `commands/rail.md` and `commands/desk.md` are Grok's `/rail` and `/desk`. `commands/approve-brief.md` is `/approve-brief`. A chat message that is exactly `approved` does the same. `commands/schedule.md` is `/schedule`. Leave `commands` out of `plugin.json`.

The rest of the file map is in CLAUDE.md.

## Install

From this folder.

Claude reads it in place: `claude plugin marketplace add <this folder>` then `claude plugin install session-rail@workbench`.

Grok copies it: `grok plugin marketplace add <this folder>` then `grok plugin install <this folder> --trust`. Start a new `grok`. It does not open the panes. Refresh with `grok plugin uninstall session-rail --confirm` and the install again.

## Tests

Asked how to test this project, run the fence below. The Stop hook runs that same command, unless this checkout sets `session-rail.json` (`testCommand`) or `.git/session-rail/tests.json` (`command`).

```test
claude plugin validate .
claude plugin test .
node bin/rail.mjs --frame 42 40
node bin/rail.mjs --frame 42 40 --tab git
node bin/desk.mjs --frame 80 40 --tab diff
```

One command per line. The hook joins them with `&&`. Type-check notes stay in CLAUDE.md.

## Rules

- macOS and iTerm2 for the panes. Elsewhere the plugin stays quiet.
- `pane.mjs` must never launch iTerm2, and it stops at the nearest `grok` or `claude` process.
- Sanitize text drawn from task output, diffs, plans, or review findings (`clean()` in `bin/term.mjs`).
