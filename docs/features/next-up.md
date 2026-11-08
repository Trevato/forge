# Next up

`/:owner/:name/next` is the one ranked list the crew builds from (#8694). It shows the top ten in rank order with who is on each and, in one line, why a row cannot start yet; the rest is one line that opens `?all=1`, with the "Not now" work behind the Later gate below it.

- **Role:** each row is tagged *Blocker* (it holds other open work up: "finishing it frees N") or *Enabler* (it holds nothing up; its line says what it serves, else that the owner ranked it). The tag is a label only: it never changes the order the picker takes work in.
- **Move:** `Top` (`t`), `Up` (`u`), `Down` (`d`) and `Not now` (`n`) are forms on each row, with the key shown beside each; `j`/`k` choose the row, and a row can be dragged. Each is one `POST /:owner/:name/next` (`number`, `to` = `top`, `not-now` or `after:<number>`) and saves at once. Writers only; the same-origin check applies.
- **Top lifts the gate:** `Top` on a deferred issue removes its `wait_for` edge to the Later gate (and the Later umbrella's edge to it) in the same action. Work that only deferred work needs stays deferred, and the refusal says so.
- **Not now** links the issue to wait for the open Later gate and drops its rank.
- **The picker** takes the highest ranked startable issue before anything else, small work included (`readyNow`, `slotOrder`). A ranked issue something still blocks is skipped, never waited on. Same state, same pick.
- **MCP:** `next_up { app, issue?, to?, all? }` reads the list, or moves one issue with the same words.
- A rank is cleared when the issue closes. Dependencies order within the list and are shown, never edited here.

**Terminal:** the palette's "Next up in a repository" opens the same list; `t`, `u`, `d` and `n` are Top, Up, Down and Not now on the row under the cursor, through the same action as the page and MCP. A reader sees the order and the keys do nothing; a move made anywhere reorders an open screen live. At most 200 issues are ranked; a move past that is refused and says so.

## The week is the sprint (#8704)

The subscription's weekly reset is the sprint boundary; what the crew may still spend before it is the capacity (`flow/week.ts`, from `core/standing.ts`). No ceremony and no locked scope: rerank any time and the line moves on the next paint.

- **Estimates:** each row shows a cost range (the 25th to 75th percentile of what past closed issues of the same size and kind cost, every agent run on them summed, `flow/estimate.ts`). With fewer than three comparable issues it falls back to size alone, then says "too little history". Measured, never asked of an agent: no run is spent.
- **Cut line:** walking from the top, the running median estimate is held against the capacity; the line falls before the first issue that does not fit and everything under it reads as next week. An issue with no estimate counts as the median of the others; with none estimated, or no capacity read, there is no line and the sentence says why. Same list and history, same line.
- **Projection:** one sentence above the list: how many should ship by the reset, as a range from the high and low ends of the estimates, and a confidence (high at eight or more samples on every row).
- **Retrospective:** once an hour the forge keeps the projection of the open window (`week_projection`) and, for a window that has ended, writes `week_retro` once (`flow/retro.ts`): what shipped against the projection, how many shipped issues cost inside their range, what open work cost most, what is stuck (two failed runs or more, and the class of the last failure, never the run's own output), and at most three proposals. `/:owner/:name/week` and the MCP `week` tool show it. A proposal is one tap (`POST /:owner/:name/week`, or `week { app, take }`) by a writer who is a person; it puts the issue behind the Later gate, the same move as `Not now`, and is taken at most once. Nothing changes without that tap. Only a person who writes can take one: `takeProposal` refuses an agent and a reader for every door.
- **Not done here:** the line falls between issues, not whole scopes, because bets and scopes (#8713) are not in the forge yet; when they land the line moves to their edges. The health mark per group is left for the same reason.
- **Live:** a drag posts the move and the page reloads itself from the server, which redraws the line; there is no manual reload, but it is a reload, not a client-side recompute.
- **Terminal:** Next up shows each row's range and a muted "this week ends here" line under the last issue that fits, with the projection in the header. "The week in a repository" (palette) shows the retrospective; `j`/`k` choose a proposal and `enter` or `a` takes it, through the same `takeProposal`. A reader or an agent sees it and the key does nothing; a new retrospective (`week.retro`) or a proposal taken anywhere updates the open screen. MCP `next_up` rows carry `estimate` and `thisWeek`, with a `projection` sentence.
- Sealed issues are left out of history and of the retrospective, so their cost never shapes a visible range.
