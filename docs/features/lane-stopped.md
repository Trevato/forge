# The lane has stopped (#11507)

On 2026-11-12 nothing merged for 12 h 51 min and nothing said so: every check was being stopped for CPU, and main was not ahead of production, so the main-ahead alarm stayed quiet. The flow alarm `lane_stopped` (`src/flow/alarm_lane.ts`) fires for the forge's own repository in two states, as one alarm:

- **The lane has stopped:** pulls are open (or work is ready), the crew is not at its ceiling, and no pull has merged for 90 minutes. Change the limit with the `flow.lane_minutes` row of `forge_setting` (a whole number, 1 to 10080; anything else is 90). It names how long, how many checks failed since the last merge and the commonest failure line verbatim.
- **One cause failing many pulls:** the same failure line (numbers masked) failed checks on five different pulls within an hour and since the last merge. The line is the first line of a check's summary, for a check that named no failing test; a named test is `src/checks/shared_red.ts`'s. /flow says it is the forge's failure; `check_failed` is not sent to builders for it (`waitOnMain` in `src/crew/dispatch.ts`) and the stale-red sweep neither parks nor reworks its pulls, only checks them again.

It is an ask for the owner and one Sentinel issue (`src/crew/sentinel_lane.ts`), closed at the next hunt after a pull merges and the cause is gone, unless a person commented on it. `land_past_gate` does not open for it: the break-glass rests on red gates only (`landingStopped` in `src/checks/gate_stopped.ts`), since a merge drought with pulls waiting on review is not a red gate.

Left out: the Sentinel issue's evidence carries the failure count, so it is commented again as that count moves.
