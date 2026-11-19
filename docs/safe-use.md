# Safe use

The files in `docs/safe-use/` are a **starting point, not a guarantee**. `claude.settings.json` is a starting point, not a guarantee. Copying one does not put your Mac in a container, and it does not make a Workbench session safe to leave alone with your keys.

Workbench runs on the host Mac. The plugin and the agent share that machine.

## What the plugin can reach

`bin/pane.mjs` talks to iTerm2 with AppleScript. It can fill the window, split panes, focus a session, open a window, and type a line into a pane and submit it. After you approve a brief, the plugin types the go-ahead into that session. macOS asks you to allow control of iTerm2. That permission is the plugin's reach.

Claude Code's Bash sandbox wraps Bash, PowerShell, and Monitor commands and the processes they start. Read, Edit, Write, WebFetch, MCP servers, hooks, and this plugin run outside it. Grok's sandbox is off until you select a profile. On macOS its child-network limit is a no-op, and the built-in profiles do not hide `~/.ssh`. `~/.grok/` stays writable so the session can be saved.

[OpenHands](https://docs.openhands.dev/openhands/usage/sandboxes/overview) runs the agent in a Docker sandbox by default. Workbench does not. An unattended loop wants a machine you can throw away and credentials that are not your real ones. This plugin is your Mac, your terminal, and your login.

## Leave the prompt on

Start Claude Code in Manual mode (`permissions.defaultMode` set to `default`). Start Grok with `permission_mode = "ask"`.

The starter keeps those modes. It sets `permissions.disableBypassPermissionsMode` to `"disable"`, so Claude Code refuses bypass mode, including a session started with `--dangerously-skip-permissions`. It leaves `sandbox.autoAllowBashIfSandboxed` false. With that key true, sandboxed Bash runs without a prompt, including writes inside the working directory, while Manual mode is still on. Grok's `auto_allow_bash` stays false for the same reason. The starter does not set Grok's `always-approve`, `auto`, or the legacy `yolo = true`.

`permissions.defaultMode` values `auto` and `bypassPermissions` do not take effect from a project's `.claude/settings.json` or `.claude/settings.local.json`. User settings and the CLI flag still can, which is why the bypass lock belongs in the file you merge into `~/.claude/settings.json`.

Press "Yes, and don't ask again" for a command you have read. Claude Code writes that allow rule to `.claude/settings.local.json` at the **main checkout**, including when you are in a worktree. A Workbench **+ new** worktree (`<repo>.worktrees/<name>`) shares that file, so a rule saved in one session applies to every worktree of the repo. A broad rule such as `Bash(git *)` covers every git subcommand, including forms the permission docs warn about.

Approve a brief for a checkout you mean the agent to edit. The brief gate is a plugin check. It is not an operating-system sandbox.

## The brief gate and shell writes

On this release the gate covers Edit, Write, and NotebookEdit. [PR #61](https://github.com/sarmilan/workbench/pull/61) is open and not merged. It would add `bin/shellwrite.mjs` so a shell command that creates, overwrites, moves, or deletes a file in the checkout waits on the same gate, for Claude's `Bash` and Grok's `run_terminal_command`. In that change, `git log`, tests, and commits still run, `gh pr merge` stays on the review gate, the brief file can still be written, and its approval file cannot. A command whose path is not a literal is treated as a write, so you run it yourself. The denial uses the same brief reason, the rail shows Held, and the pet keeps its `?`.

That check, once it lands, still runs inside the plugin. A command that writes outside the checkout is outside it.

## Claude Code

Merge [`claude.settings.json`](safe-use/claude.settings.json) into `~/.claude/settings.json`. That file applies to every project on this Mac. To share rules with a repo, merge the `permissions` and `sandbox` objects into that repo's `.claude/settings.json`. `deny` and `ask` apply before you trust the folder. `allow` rules in the project file wait until you accept the workspace trust dialog. In a worktree, that trust is keyed on the main checkout.

The sample:

- Pins Manual mode and refuses bypass mode.
- Asks before `git push`, `gh pr merge`, and `npm publish`. An ask rule still prompts when an allow rule also matches. A content-scoped ask such as `Bash(git push *)` still prompts for a sandboxed command.
- Denies the usual spellings of `rm -rf`, `curl`, `wget`, and `sudo`, and denies reads and edits of `~/.ssh`, `~/.aws`, `.env`, and `.pem`.
- Turns the Bash sandbox on, with auto-allow off, unsandboxed retries off, and `failIfUnavailable` true.
- Denies sandboxed reads of `~/.ssh` and `~/.aws`.
- Leaves `network.allowedDomains` empty, so a sandboxed command has no preapproved host. The first new host asks you. An empty list does not seal the network. To refuse other hosts instead of asking, set `sandbox.network.strictAllowlist` to true in user, managed, or `--settings` configuration. A repository settings file cannot set that key.

Rules are evaluated deny, then ask, then allow. An allow rule cannot carve a hole in a deny rule.

A Bash rule matches the command text after Claude Code splits compound commands and strips wrappers such as `timeout` and bare `xargs`. `Bash(curl *)` stops `curl https://example.com`. It does not stop `/usr/bin/curl` or `sh -c 'curl …'`. The sandbox network check is the layer that does not depend on the spelling. Read and Edit deny rules cover the file tools and the commands Claude Code recognizes (`cat`, `head`, `sed`, `tee`, and redirects). A `Read` deny also blocks Edit and Write on that path. The extra `Edit` rules cover NotebookEdit, which a `Read` deny leaves alone. A Python or Node script that opens a file itself is outside those rules. The sandbox is the OS boundary for shell children.

`failIfUnavailable: true` makes Claude Code exit when the sandbox cannot start, instead of running commands with no sandbox. On a Mac the sandbox uses Seatbelt. On Linux and WSL2 it needs `bubblewrap` and `socat`.

The official strict example also asks for every Bash command (`"ask": ["Bash"]`). Add that when you want a prompt even for `ls` and `git status`. This starter leaves read-only commands on Claude Code's built-in allow path and asks for the publish, push, and merge commands above.

The rail's own `gh` calls are the plugin, outside the sandbox. The sample does not hide `~/.config/gh`. Add `Read(~/.config/gh/**)` and a sandbox `denyRead` of `~/.config/gh` when the agent should not use your GitHub CLI login. A sandboxed `gh` would then be unable to read that directory, and `allowUnsandboxedCommands: false` means Claude cannot retry it outside the sandbox.

Official pages: [Configure permissions](https://code.claude.com/docs/en/permissions), [Configure the sandboxed Bash tool](https://code.claude.com/docs/en/sandboxing). The claude-code repository's [settings examples](https://github.com/anthropics/claude-code/blob/main/examples/settings/README.md) are the organization-sized version of the same idea. This starter follows those examples in leaving auto-allow off and disabling bypass mode. It does not set `allowManagedPermissionRulesOnly` or any other managed-only lock.

## Grok

Grok's host default is ask mode, with the sandbox off. Merge [`grok.config.toml`](safe-use/grok.config.toml) into the repo's `.grok/config.toml` for the deny and ask rules. Merge [`grok.user.toml`](safe-use/grok.user.toml) into `~/.grok/config.toml` so the mode stays `ask`, the profile is `workbench`, and `auto_allow_bash` stays false. Put [`grok.sandbox.toml`](safe-use/grok.sandbox.toml) in `~/.grok/sandbox.toml` or the project's `.grok/sandbox.toml`, and replace `/Users/you` with your home directory.

A project `.grok/config.toml` may set `[permission]`, MCP servers, and plugins. `permission_mode` and `[sandbox]` belong in user config. Evaluation order is deny, then ask, then allow.

A remembered "always allow" still prompts for dangerous patterns such as `rm` and `git push`. An explicit allow rule auto-approves them. Under always-approve they run unless a deny matches. The starter denies `rm -rf` and tells you to stay on ask.

The `workbench` profile extends `workspace`: writes stay in the working directory, `~/.grok/`, and temp. `restrict_network = true` applies on Linux. On macOS a sandboxed command can still open a connection. Add absolute `deny` entries for credential directories. A glob deny (`**/.env`, `**/*.pem`) is kernel-enforced when the sandbox can be applied. On Linux a read deny needs bubblewrap.

Official pages: [Permissions](https://docs.x.ai/build/features/permissions), [Sandbox](https://docs.x.ai/build/features/sandbox), [Settings](https://docs.x.ai/build/settings).

## What the plugin sets on its own

Workbench does not change your permission mode and does not pass `--dangerously-skip-permissions`.

The approach review is a separate headless process. Claude's review uses `--permission-mode dontAsk` with Read, Grep, Glob, and `Bash(git *)` only, so a call that would prompt is denied. Grok's review uses `--always-approve` with the write, shell, and web tools removed (`--disallowed-tools write,search_replace,run_terminal_command,web_search,web_fetch`). Neither process is your iTerm session.

The review gate still refuses the agent's `gh pr merge` until the code review and the final approach review are in. You can merge yourself. The starter's ask rule for `gh pr merge` is a prompt in front of that gate.

## Check it

Read the JSON and the TOML before you merge them into a settings file you already have. Keep hosts and allow rules you still want. Then start a session and ask for something the deny list names, such as `curl https://example.com` or a read of `~/.ssh`. You should see a refusal. In Claude Code, `/sandbox` should show the sandbox on and auto-allow off. In Grok, the status should say ask.
