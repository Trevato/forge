# Next up says why a ready issue is not started (#8924)

- **A lift places the issue.** Taking an issue from behind the Later gate (the Lift button, the `wait_for` tool with `stop`, the pacer's release) leaves it under a pillar: the one it already serves, else the first, whose umbrella then waits for it. The one place is `stopWaiting` (`src/actions/gate.ts`), which `liftHold` and `wait_for` stop share, via `servePillar` (`src/core/pillar_pick.ts`), so neither route skips it; taking the `Later` label off by hand is not a lift, for the label puts the gate back.
- **No silent case.** Every ready issue a builder will not start carries one reason on Next up (web, terminal, MCP `next_up` as `why`): what `held.ts` holds (a run, a pull, a cap, a hot file, a stall), or what the picker passes over (`src/crew/pick_filter.ts`): `polish_share`, `no_bet`, `no_builder`. The tick line counts the passes.
- Not explained, because they need git: issues retired as already done on the base are closed with a note on the tick, not listed.

`notStartable` (`src/crew/not_startable.ts`) joins the two; the page reads the scope once. Tested in `test/not-startable.test.ts` and `test/lift-startable.test.ts`.
