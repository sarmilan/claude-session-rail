# claude-session-rail: dev notes

A Claude Code plugin (repo root = plugin = marketplace) that opens a Claude-desktop-style session rail as an iTerm2 split. See README.md for behavior and architecture.

## Layout
- `bin/rail.mjs`: the terminal UI, with Session and Git tabs (modes: interactive, `--json`, `--frame W H [--tab session|git] [--activate a,b] [--open-context]`)
- `bin/desk.mjs`: the wider Plan / Diff / Review panel (modes: interactive, `--json`, `--frame W H [--tab plan|diff|review] [--file N] [--review-json F --select N --jump N]`)
- `bin/reviewer.mjs`: the approach review: a headless staff-engineer review of the branch (`claude -p --json-schema`, read-only) from its brief and chunk records, which also checks the earlier open findings. Kept per branch in `.git/session-rail/reviews/`. `reviewAndSave` serves the desk's Run review and the CLI `node reviewer.mjs --run [--final] [--notes JSON]`, which the hooks' `review_approach` tool runs
- `bin/cadence.mjs`: the review cadence's rules (pure, no Node APIs, shared by the hooks, the reviewer and the desk): the record's run and finding shape, finding statuses (open, applied, declined), a /code-review report (its final ```json findings block, `reportFromText`) as a code run, `staffCheck` (the code findings the approach review judges), and `gateReason`, which says why a merge must wait
- `bin/term.mjs`: drawing helpers shared by the rail and the desk (colours, display width, wrap, `clean()`)
- `bin/fontsize.mjs`: one font size for the Claude, desk and rail panes (Settings in the rail). Writes generated iTerm profiles to `~/Library/Application Support/iTerm2/DynamicProfiles/session-rail.json` and switches each pane with `OSC 1337;SetProfile`
- `bin/brief.mjs`: the session brief in `.git/session-rail/briefs/<branch>.md` (parse, status, approval record). Pure, no Node APIs: shared by the desk and the hooks
- `bin/sources.mjs`: data sources. Every export resolves to plain JSON and never throws. `sessionsOverview` feeds the rail's Sessions; `worktrees`, `environment().commits` and `prs()` (with each PR's `checks`) feed its Git tab; `newWorktree` adds the detached worktree for **+ new** in `<repo>.worktrees/<slug>`
- `bin/mascot.mjs`: the mascot at the bottom of the rail: movement, inline PNG in iTerm2, Unicode octants in `--frame`/elsewhere
- `bin/creatures.mjs`: the mascot sprites (34×16 pixel drawings, palette, gait). Add a creature by appending to `CREATURES`.
- `bin/habitats.mjs`: the foliage behind the mascot (woodland, pond, beach), picked by each creature's `habitat`
- `bin/pane.mjs`: iTerm2 split controller (`open|close|toggle|status [rail|desk]`, plus `focus <tty>` and `window <tty> <command>` for the rail's Sessions; prints one JSON line, always exits 0). Layout: Claude │ desk │ rail
- `hooks/register.ts`: plugin hooks (session.start opens the rail then the desk, `/rail`, `/desk`, session.end closes both; `/start` once per session, skipped when the rail's **+ new** set `SESSION_RAIL_STARTED`; on a feature branch the brief: a system prompt section, `/approve-brief`, and a gate on Edit/Write/NotebookEdit until it's approved. Once it's approved, the review cadence: the `review_approach` tool, /code-review's report recorded as a code run (a Skill tool call, or the person typing /code-review, arms `$.state.codeReview` with a token; the run's first prompt asks for the token inside its final JSON findings block, and the `turn.complete` answer carrying it is the report, forked or inline), and `gh pr merge` in Bash refused until `cadence.gateReason` is satisfied; commits aren't gated)
- `hooks/goahead.ts`: when to tell Claude the brief was approved (pure). register.ts polls the approval every 2s, keeps the last one seen in `$.state`, and sends the go-ahead with `$.prompt.submit`
- `hooks/compact.ts`: when to compact the session on its own (pure): after leaving a branch whose brief has a Done chunk and whose tip is in the default branch. register.ts's 2s poll tracks the branch in `$.state`, calls `$.session.compact` once Claude is waiting (at most 3 tries), records `compacted` in the activity file, and skips it when `~/.claude/session-rail/settings.json` has `autoCompact: false`
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
node bin/rail.mjs --frame 42 40 --tab git
node bin/desk.mjs --frame 80 40 --tab diff
```
Type-check with a tsconfig that includes the engine's `claude-code.d.ts` and `hooks/` (see the header of that file).

## Local dev install
`claude plugin marketplace add <this folder>` then `claude plugin install session-rail@claude-session-rail`. The plugin is read from this folder, so `/reload-plugins` picks up edits.
