# claude-session-rail: dev notes

A Claude Code plugin (repo root = plugin = marketplace) that opens a Claude-desktop-style session rail as an iTerm2 split. See README.md for behavior and architecture.

## Layout
- `bin/rail.mjs`: the terminal UI (modes: interactive, `--json`, `--frame W H [--activate a,b] [--open-context]`)
- `bin/desk.mjs`: the wider Plan / Diff / Review panel (modes: interactive, `--json`, `--frame W H [--tab plan|diff|review] [--file N] [--review-json F --select N --jump N]`)
- `bin/reviewer.mjs`: the desk's Review tab: a headless staff-engineer review of the branch's approach (`claude -p --json-schema`, read-only) from its brief and chunk records, kept per branch in `.git/session-rail/reviews/`
- `bin/term.mjs`: drawing helpers shared by the rail and the desk (colours, display width, wrap, `clean()`)
- `bin/fontsize.mjs`: one font size for the Claude, desk and rail panes (Settings in the rail). Writes generated iTerm profiles to `~/Library/Application Support/iTerm2/DynamicProfiles/session-rail.json` and switches each pane with `OSC 1337;SetProfile`
- `bin/brief.mjs`: the session brief in `.git/session-rail/briefs/<branch>.md` (parse, status, approval record). Pure, no Node APIs: shared by the desk and the hooks
- `bin/sources.mjs`: data sources. Every export resolves to plain JSON and never throws. `sessionsOverview` feeds the rail's Sessions; `newWorktree` adds the detached worktree for **+ new** in `<repo>.worktrees/<slug>`
- `bin/mascot.mjs`: the mascot at the bottom of the rail: movement, inline PNG in iTerm2, Unicode octants in `--frame`/elsewhere
- `bin/creatures.mjs`: the mascot sprites (34×16 pixel drawings, palette, gait). Add a creature by appending to `CREATURES`.
- `bin/habitats.mjs`: the foliage behind the mascot (woodland, pond, beach), picked by each creature's `habitat`
- `bin/pane.mjs`: iTerm2 split controller (`open|close|toggle|status [rail|desk]`, plus `focus <tty>` and `window <tty> <command>` for the rail's Sessions; prints one JSON line, always exits 0). Layout: Claude │ desk │ rail
- `hooks/register.ts`: plugin hooks (session.start opens the rail then the desk, `/rail`, `/desk`, session.end closes both; `/start` once per session, skipped when the rail's **+ new** set `SESSION_RAIL_STARTED`; on a feature branch the brief: a system prompt section, `/approve-brief`, and a gate on Edit/Write/NotebookEdit until it's approved)
- `hooks/activity.ts`: the session's live activity (pure state changes) that register.ts writes to `~/.claude/session-rail/activity/<session id>.json` for the rail's Now section; the desk writes `<session id>.desk.json` beside it
- `tests/register.test.ts`: plugin tests

## Rules
- Zero npm dependencies; plain Node 18+ ESM in `bin/`. The hooks module has no Node APIs (it uses `$.process`, `$.plugin.root`).
- `pane.mjs` must never launch iTerm2 and must stop at the nearest `claude` process (a headless `claude -p` has no TTY and must not act on an outer session).
- Sanitize anything drawn from task output, diffs, plans or review findings (`clean()` in term.mjs).
- macOS only: `pgrep` can't see iTerm2 from Claude's sandboxed shells, so use `ps`. bash is 3.2.

## Check before committing
```
claude plugin validate .
claude plugin test .
node bin/rail.mjs --frame 42 40
node bin/desk.mjs --frame 80 40 --tab diff
```
Type-check with a tsconfig that includes the engine's `claude-code.d.ts` and `hooks/` (see the header of that file).

## Local dev install
`claude plugin marketplace add <this folder>` then `claude plugin install session-rail@claude-session-rail`. The plugin is read from this folder, so `/reload-plugins` picks up edits.
