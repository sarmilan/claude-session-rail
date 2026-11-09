# claude-session-rail: dev notes

A Claude Code plugin (repo root = plugin = marketplace) that opens a Claude-desktop-style session rail as an iTerm2 split. See README.md for behavior and architecture.

## Layout
- `bin/rail.mjs`: the terminal UI (modes: interactive, `--json`, `--frame W H [--activate a,b] [--open-context]`)
- `bin/sources.mjs`: data sources. Every export resolves to plain JSON and never throws.
- `bin/mascot.mjs`: the mascot under the legend: movement, inline PNG in iTerm2, Unicode octants in `--frame`/elsewhere
- `bin/creatures.mjs`: the mascot sprites (34×16 pixel drawings, palette, gait). Add a creature by appending to `CREATURES`.
- `bin/pane.mjs`: iTerm2 split controller (`open|close|toggle|status`, prints one JSON line, always exits 0)
- `hooks/register.ts`: plugin hooks (session.start auto-open, `/rail`, session.end close)
- `tests/register.test.ts`: plugin tests

## Rules
- Zero npm dependencies; plain Node 18+ ESM in `bin/`. The hooks module has no Node APIs (it uses `$.process`, `$.plugin.root`).
- `pane.mjs` must never launch iTerm2 and must stop at the nearest `claude` process (a headless `claude -p` has no TTY and must not act on an outer session).
- Sanitize anything drawn from task output (`clean()` in rail.mjs).
- macOS only: `pgrep` can't see iTerm2 from Claude's sandboxed shells, so use `ps`. bash is 3.2.

## Check before committing
```
claude plugin validate .
claude plugin test .
node bin/rail.mjs --frame 42 40
```
Type-check with a tsconfig that includes the engine's `claude-code.d.ts` and `hooks/` (see the header of that file).

## Local dev install
`claude plugin marketplace add <this folder>` then `claude plugin install session-rail@claude-session-rail`. The plugin is read from this folder, so `/reload-plugins` picks up edits.
