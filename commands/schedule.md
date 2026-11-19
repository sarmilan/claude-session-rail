---
description: Run the bounded CI chore. It does not merge.
disable-model-invocation: true
---

Chores stay off until the rail's settings have Chores on (`"chores": true`). Do not turn that on yourself.

When it is on, run `node bin/chore-run.mjs` from this repo. `start` makes a detached worktree and the state file. `round --dry-run --failing <note>` spends one round. `show` prints the summary. `stop` leaves the file for a person.

Do not run `gh pr merge`. Do not approve the brief. Do not edit the repo as part of this command. If Chores is off, say so and stop.
