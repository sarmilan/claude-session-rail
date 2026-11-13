# Pets

The pet is the creature at the bottom of the rail. It is the session's body language: one glance should say whether the agent is working, whether the branch is moving, and whether something is stuck. It is not a control. Picking a creature is a preference, remembered for every session.

It lives only on the rail, and only when the pane is at least 24 rows tall and wide enough for the sprite. In iTerm2 it is one inline picture: the creature, its habitat, and a floor line that lines up with the input rule in the pane beside it. Elsewhere it falls back to text blocks. The picture updates about five times a second.

## The cast

Three creatures. Each one has a habitat, a walk, a baby, and four drawings as it grows.

| Creature | Habitat | How it walks | Baby |
| --- | --- | --- | --- |
| Snail | Woodland: ferns, mushrooms, pebbles, soil | Stretches forward, then the shell catches up. Two eye stalks. | A tiny shell and body |
| Turtle | Pond: reeds, grass, rocks, mud | Steps with front and back legs swapping. Tucks into its shell to sleep. | A small shell on four legs |
| Crab | Beach: sand, seaweed, shells, pebbles | Sideways. It never turns around; it just walks the other way. Claws open and shut with each step. | A tiny crab |

`c`, or **Pet** in the rail's settings, cycles them. The choice is saved in `~/.claude/session-rail/mascot.json` and shared by Claude and Grok.

Plants are laid out once for a given width, so the scenery stays put. Tall plants lean back and forth about once a second. The reeds lean harder when the turtle hops, and the beach kicks up a little sand while the crab is moving.

## What a glance is supposed to tell you

Each channel carries one fact. They stack: a heavy crab can be hurrying, trailed by two babies, with a bee overhead and a red puff.

| What you see | What it means |
| --- | --- |
| Which creature, and its habitat | Your pick. Nothing about the session. |
| Where it lives on the strip, left to right | How much of the branch's brief is Done. |
| How grown-up it looks | How close the branch is to being finished and compacted. |
| Walking, hurrying, fidgeting, or asleep | Whether work is happening, or it is your move, or nothing is. |
| Where it faces | Waiting for you: it looks left, toward the agent pane, and fidgets. |
| A hop, a shake, a gold mark | The branch is far along. Heavy means ready to merge. |
| Markers on the road, and a gold sparkle | Chunks that are Done. The sparkle is the one that just finished. |
| A yellow `?`, standing still | This branch's brief is not approved yet. |
| A flinch, a red puff, then a droop | A tool call failed. The droop stays until a later call succeeds. |
| A bee, butterfly, dragonfly, or ladybird | A subagent is running. Its colour matches that subagent in Now. |
| A `+n` | More subagents or shells than the strip can draw. |
| A baby of the same creature, trailing behind | A background shell is running. |

The floor is the branch's road.

- No brief: it wanders the whole strip.
- A brief that is not approved yet: it stays at the left edge.
- Approved, or approved and then edited: its home moves right by the share of chunks marked Done. It paces a few columns either side of that home, and walks straight there when a chunk flips. Each Done chunk also leaves a marker on the road behind it: a mushroom in the woodland, a lily pad on the pond, a shell on the beach. The moment a chunk flips, the pet hops and a gold sparkle pops.

Position and the trail are the fine reading of progress. The stage is the coarse one.

## Stages

The same four stages for every creature. After a compaction the next branch has no approved brief, so the pet hatches again.

| Stage | When | How it looks | How it moves |
| --- | --- | --- | --- |
| Hatchling | The brief is missing or not approved | Pale and small. Big head on the turtle, nubs on the crab, a little coiled shell on the snail. | Slowest walk. No hop. |
| Juvenile | Approved, nothing Done yet | The everyday creature: green shell, orange crab, woodland snail. | Normal walk. |
| Adult | At least one chunk Done, not all of them | Darker, with a brow. The turtle grows a ridge, the crab grows shell spots and a fourth pair of legs. | Faster, and a small hop now and then. |
| Heavy | Every chunk Done | Bigger, a row taller. Spikes, a scowl. The turtle's shell goes amber, the crab wears a gold crown. | Bigger hops, the body shakes, and a gold mark pops over it. The prompt is: merge it and let the session compact. |

A stage change is instant. The drawing swaps. There is no grow animation. From adult on, the hop is shared by every creature. The gold mark and the shake belong only to heavy.

Sleep, the gate, and a failure all interrupt this. Asleep, the gold mark hides and the hops stop. Held by the gate, it freezes on the spot. A failure shakes it for a moment whatever the stage, then leaves the droop.

## Motion

A tick is about 200ms.

**Walk.** Two frames. The snail and the turtle move on one of them, so they lumber. The crab moves on both, so it scuttles. Every few seconds it blinks.

**Hurry.** While the current session is busy, or any background task is running, it takes a step every tick. It also hurries while it is walking to a new home after a chunk is marked Done, then settles back into a pace.

**Waiting.** When the turn has ended and it is your move, it stops walking, faces left toward the agent pane, and fidgets. It does not lie down. A crab has no face to turn, so it snaps a claw instead. After an hour with no new turn, waiting becomes idle. This follows the activity feed the hooks write for Claude and for Grok. Claude's own session file can still say busy after the turn has ended, and Grok's session file never says busy; the feed wins either way. A background shell, a monitor, or a subagent the turn left running keeps the pet busy.

**Fidget.** Every few seconds of ordinary walking it pauses for a short beat. The snail holds a long stretch, the turtle pops its head up, the crab snaps the near claw. Waking from sleep is the same beat, with a small hop.

**Sleep.** After a minute of idle, with nothing busy and with nobody waiting, it stops. Zs float up. The turtle pulls into its shell, the crab folds its claws, the snail lowers its body. Any new work wakes it with a stretch.

**Hop and shake.** Adult hops a short arc about every three seconds. Heavy hops twice as often, higher, and sometimes rattles in place. A chunk just marked Done hops once, higher, whatever the stage.

**Flinch.** A failed tool call shakes the body and pops a red-and-orange puff for a second and a half. The fliers scatter and the babies duck behind it. After the puff, a small red droop stays, and the body sits a little lower, until a later tool call succeeds. A refusal from the brief gate does not flinch. Red is only this.

**Held.** While the branch has a brief that is not approved yet, the pet stands still, awake, with a yellow `?` over its head. Approving it, including an approval kept after an edit, lets it walk. A branch with no brief is not held.

## Company

**Visitors** are the fliers. One appears for each running subagent, counting both a subagent call on the main thread and a background subagent. They arrive in a fixed order: bee, butterfly, dragonfly, ladybird, then the bee again. At most four are drawn. Each is tinted with its subagent's colour from the Now list, so a bee can be matched to a name. Each flies in from an edge and hovers to one side of the pet. While the agent is busy they wobble high. While it is quiet they settle low. A failed tool sends them scattering, then they come back. They fly off the nearest edge when their subagent finishes. A fifth subagent draws a `+n` instead of a fifth flier.

**Babies** trail behind, one per running background shell, at most three. They face the way the parent walks and bob. They bunch up behind it when the strip is crowded. While it sleeps they tuck down beside it. While the brief is unapproved they pile up at its heel. On a flinch they hide behind it. They are not shells started by a subagent. Those subagents are visitors. A fourth shell draws a `+n`.

## What the pet does not say

These are true of the session and invisible on the strip.

- **Which thing failed.** The droop says a call failed and has not been followed by a success. The rail's activity list is where the failed call stays, with its name.
- **Which subagent is which, by name.** The flier's colour matches the Now list. The name itself stays in that list. Past four, the extras are only a count.
- **How the middle of a stage feels.** Two chunks of eight and seven of eight are both "adult". The home spot and the trail of markers are what separate them. The pet still paces around its spot, so the trail is the clearer of the two.
- **Reviews, checks, context, or rate limits.** Those stay in the rest of the rail and the desk. The pet never mentions them.

Red is only a failed tool. Gold is only "ready to merge" and "a chunk just finished". Yellow is only the unapproved brief.

## Where this lives

- `bin/creatures.mjs`: the three creatures, their four drawings, and their babies.
- `bin/habitats.mjs`: woodland, pond, beach.
- `bin/visitors.mjs`: the four fliers and how they flock.
- `bin/mascot.mjs`: walking, sleep, stages, the road, marks, and the picture.
- `bin/rail.mjs`: wires the pet to the brief, the session, subagents, shells, failures, and the gate.
