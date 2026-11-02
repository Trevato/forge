# How much each seat may do at once (#7668)

Settings › Team shows three seats: planner, builder, reviewer. Each has a number: how much it may do at once. **0 pauses the seat without taking its agent off the crew.** Under each seat is what it is doing now (running, waiting) and today's spend with its share (UTC day).

| Seat | Number | What it bounds | At 0 |
|---|---|---|---|
| Planner | 0–1 (`plannerSlots`) | planning passes | the planner is not asked, and the forge does not lend one |
| Builder | 0–8 (`autonomySlots`) | builds at once | nothing new is picked; what runs is not cut |
| Reviewer | 0–8 (`reviewerSlots`) | reviews in flight (8, the default, is no cap) | no review is sent; an agent's pull waits for a person, as with no reviewer |

A change takes effect on the next tick and is a `repo.settings_updated` line on the trail, `{ from, to }` per number. A repository admin's call, as the autonomy form is; over the MCP an agent is refused.

**Terminal:** the repository's Autonomy screen shows the three seats; `p`, `s`, `r` set the planner, builder and reviewer, gated like the page (`canAdmin`).

**MCP:** `crew { repo, seat, slots, dryRun? }` plans first (`dryRun` true unless `false`; admin token to apply). `crew { repo }` returns `slots[{ role, slots, max, running, waiting, spentUsd, sharePct }]` beside `seats` and `governor`.

**Web:** `POST /:owner/:name/settings/pillars` with `seat` and `slots`, same-origin, admin only.

## Review of the crew settings

| Setting | Decision |
|---|---|
| Builder slots (the "Slots" field of On its own) | **Folded** into the builder seat's number. The field is gone from that form; the form keeps the value when it is not sent. |
| Planner on or off by removing it from the crew | **Replaced** by the planner's number; pausing is no longer removal. |
| Mode (off, assisted, autonomous) | Keep: the one switch for whether the team works alone. |
| Direction | Keep: what the planner plans against. |
| Ceiling per day | Keep: the only dollar limit. |
| Decisions here, Plans need a nod, Outsiders may trigger the crew | Keep: each is who answers, and none holds work silently. |
| File holds, team dials, subscriptions | Not reviewed here; they are other pages' settings. |

Not done: no other setting was deleted, and the governor's automatic lowering of builder slots is unchanged (it can only go below the number set here, never above).
