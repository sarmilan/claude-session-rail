# Workbench: dev notes

## The plan

The branch brief is the plan. Write it before any other edit, and the person approves it in the desk's Plan tab. The desk reads the folder the session was started in. A session started outside a repo has no brief, and a brief written in some other folder does not appear on that desk. Say the plan is in the Plan tab only after a frame of this session's desk shows the brief (`desk.mjs --frame 72 24 --tab plan` with this session's cwd, host and session id). A newer `plan.md` replaces the brief on that tab and has no Approve button, so do not write one in its place.

Workbench is the rail and the desk beside Claude or Grok, opened as an iTerm2 split (repo root = plugin = marketplace). See README.md for behavior and architecture.

## Layout
- `bin/rail.mjs`: the terminal UI, with Session and Git tabs (modes: interactive, `--json`, `--frame W H [--tab session|git] [--activate a,b] [--open-context] [--agents N]`)
- `bin/sessionstory.mjs`: the Session tab's tree (pure, no Node APIs). The banner says who is working and the ask they were given. The latest reply sits under the host. Open an agent for the prompt it was handed and what it answered. Finished subagents stay listed under the live ones with the task they were given. The person's prompts follow, newest first. The hooks record the prompt, the reply and the turns; `sources.chronicle` reads the transcript for the rest
- `bin/desk.mjs`: the wider Plan / Diff / Review panel (modes: interactive, `--json`, `--frame W H [--tab plan|diff|review] [--file N] [--review-json F --select N --jump N]`)
- `bin/reviewer.mjs`: the approach review: a headless staff-engineer review of the branch (`claude -p --json-schema`, read-only) from its brief and chunk records, which also checks the earlier open findings. Kept per branch in `.git/session-rail/reviews/`. `reviewAndSave` serves the desk's Run review and the CLI `node reviewer.mjs --run [--final] [--notes JSON]`, which the hooks' `review_approach` tool runs
- `bin/cadence.mjs`: the review cadence's rules (pure, no Node APIs, shared by the hooks, the reviewer and the desk): the record's run and finding shape, finding statuses (open, applied, declined), a /code-review report (its final ```json findings block, `reportFromText`) as a code run, `staffCheck` (the code findings the approach review judges), and `gateReason`, which says why a merge must wait
- `bin/term.mjs`: drawing helpers shared by the rail and the desk (colours, display width, wrap, `clean()`, `tabBar`). `usePalette('grok')` switches the chrome to GrokNight when a frame is for Grok, and the pane background to #141414; Claude keeps the 256-colour palette and its profile background. `fg` and `bg` take an index or an RGB triple
- `commands/rail.md`, `commands/desk.md`: Grok's `/rail` and `/desk`. The body is only `session-rail-command: rail|desk`, which the hook blocks and turns into a pane toggle. Leave `commands` out of `plugin.json`: an empty object fails Grok's manifest load. Claude namespaces these files as `/session-rail:rail` and `/session-rail:desk`; the `/rail` and `/desk` it registers itself stay as they are
- `bin/fontsize.mjs`: one font size for the Claude, desk and rail panes (Settings in the rail). Writes generated iTerm profiles to `~/Library/Application Support/iTerm2/DynamicProfiles/session-rail.json` and switches each pane with `OSC 1337;SetProfile`
- `bin/brief.mjs`: the session brief in `.git/session-rail/briefs/<branch>.md` (parse, status, approval record, `mainCheckoutNote`). Pure, no Node APIs: shared by the desk and the hooks
- `bin/sources.mjs`: data sources. Every export resolves to plain JSON and never throws. `sessionsOverview` feeds the rail's Sessions; `worktrees`, `environment().commits` and `prs()` (with each PR's `checks`) feed its Git tab; `newWorktree` adds the detached worktree for **+ new** in `<repo>.worktrees/<slug>`
- `bin/mascot.mjs`: the mascot at the bottom of the rail: movement, inline PNG in iTerm2, Unicode octants in `--frame`/elsewhere
- `bin/creatures.mjs`: the mascot sprites (34×16 pixel drawings, palette, gait). Add a creature by appending to `CREATURES`.
- `bin/habitats.mjs`: the foliage behind the mascot (woodland, pond, beach), picked by each creature's `habitat`
- `bin/visitors.mjs`: the fliers (bee, butterfly, dragonfly, ladybird) over the mascot's strip, one per running subagent, and how they move
- `bin/names.mjs`: subagent names (300) and colours, picked at `agent.spawn` by register.ts (pure, no Node APIs)
- `bin/cache.mjs`: the main conversation's prompt cache (pure, no Node APIs, shared by the hooks and the rail): `ttlFromUsage` (a request's 5m or 1h write), `nextCache` (a write sets the lifetime, a read renews it), `cacheView` (warm, low or cold, and the rail's Cache row text). register.ts's `turn.step` hook records it on the main loop into the activity file's `cache`, with `plan` from `$.session.usage().rateLimits` (only a subscription has them)
- `bin/host.mjs`: which agent a process belongs to (`grok` or `claude`) and the shared `~/.claude/session-rail` directory
- `bin/pane.mjs`: iTerm2 split controller (`open|close|toggle|status [rail|desk]`, plus `focus <tty>`, `window <tty> <command>` and `type <tty> <text>`; prints one JSON line, always exits 0). Layout: agent │ desk │ rail. Stops at the nearest `grok` or `claude`; a headless run with no TTY owns no pane
- `bin/grok-hook.mjs`: Grok's command hook (the same session behaviour as `hooks/register.ts`: panes, brief gate, review cadence). Outside a git checkout the first tool call of each turn is told that this folder has no brief and the desk cannot see one written in a child project. `bin/grok-watch.mjs` types the go-ahead, `/compact` and `/start` into the iTerm session, which a hook can't do itself
- `hooks/register.ts`: Claude's plugin hooks (session.start opens the rail then the desk, `/rail`, `/desk`, session.end closes both; `/start` once per session, skipped when the rail's **+ new** set `SESSION_RAIL_STARTED`; on a feature branch the brief: a system prompt section, `/approve-brief`, and a gate on Edit/Write/NotebookEdit until it's approved (shell writes in the checkout are outside that gate on main; open PR #61 would hold them). On main, master, or a detached HEAD the prompt carries `mainCheckoutNote` and a repo edit is refused until the work is on a branch with an approved brief. Grok attaches that same procedure on the first tool call of each turn. Once it's approved, the review cadence: the `review_approach` tool, /code-review's report recorded as a code run (a Skill tool call, or the person typing /code-review, arms `$.state.codeReview` with a token; the run's first prompt asks for the token inside its final JSON findings block, and the `turn.complete` answer carrying it is the report, forked or inline), and `gh pr merge` in Bash refused until `cadence.gateReason` is satisfied; commits aren't gated)
- `hooks/goahead.ts`: when to tell Claude the brief was approved (pure). register.ts polls the approval every 2s, keeps the last one seen in `$.state`, and sends the go-ahead with `$.prompt.submit`
- `hooks/compact.ts`: when to compact the session on its own (pure): after leaving a branch whose brief has a Done chunk and whose tip is in the default branch. register.ts's 2s poll tracks the branch in `$.state`, calls `$.session.compact` once Claude is waiting (at most 3 tries), records `compacted` in the activity file, and skips it when `~/.claude/session-rail/settings.json` has `autoCompact: false`. Also the warm compact: `warmCompactDue` is true in a waiting session's cache's last stretch (50 minutes into 1h, 4 into 5m, from `bin/cache.mjs`), with 50k+ tokens, at least 15s before expiry, and nothing compacted since the last request. The same poll calls `$.session.compact` with `warmInstructions` (at most 3 tries per request, read on `$.clock.now()`), records `compacted { after: 'cache' }` and the cache's `compactedAt`, and skips it with `warmCompact: false`
- `hooks/activity.ts`: the session's live activity (pure state changes, the prompt cache among them) that register.ts writes to `~/.claude/session-rail/activity/<session id>.json` for the rail's Now section; the desk writes `<session id>.desk.json` beside it
- `tests/register.test.ts`: plugin tests

## Rules
- Zero npm dependencies; plain Node 18+ ESM in `bin/`. The hooks module has no Node APIs (it uses `$.process`, `$.plugin.root`).
- `pane.mjs` must never launch iTerm2 and must stop at the nearest `grok` or `claude` process (a headless `grok -p` / `claude -p` has no TTY and must not act on an outer session).
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
`claude plugin marketplace add <this folder>` then `claude plugin install session-rail@workbench`. The plugin is read from this folder, so `/reload-plugins` picks up edits.

Grok reads the same folder. `hooks/hooks.json` keeps the Claude module and adds command hooks that `bin/grok-hook.mjs` ignores unless the process is an interactive `grok`. Install with `grok plugin marketplace add <this folder>` then `grok plugin install <this folder> --trust`, and start a new `grok` in iTerm2. That install copies the folder. Refresh it with `grok plugin uninstall session-rail --confirm` and the install again.
