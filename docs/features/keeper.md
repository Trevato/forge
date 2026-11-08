# The throughput keeper (#7645)

The forge watches its own landing rate, names the one thing binding it, and acts where the act is reversible and its own. `src/flow/keeper.ts` ticks once a minute. It reads the database and asks no model, so it still speaks when the subscription is out.

1. **Measure** (`keeper_rate.ts`): pulls landed per hour over the last 3 h against the best 3 h rate of the week before, and the share of the last 24 hours that ran (a landing or a builder run started). Low is under half the best and under one an hour.
2. **Find** (`keeper_cause.ts`): the first of `ceiling`, `usage` ("resets at HH:MM UTC"), `unassigned`, `empty_pillar`, `stale_reds`, `red_checks`, `stale_pile`, `capacity`. It asks the dispatcher's own questions (`heldNow`, `atCeiling`, `pace`).
3. **Act**: `unassigned` sweeps assigned issues with no run. `empty_pillar`, `red_checks` and `stale_pile` become one filed issue in the forge's own repository, once a week per cause (`stale_pile`'s issue lists the ten oldest waiting pulls, red and conflicted ones left out, so a builder knows where to start). `ceiling`, `usage`, `capacity` and `stale_reds` (the crew's red-pull sweep is already at it) are only said.
4. **Check** after 2 h: landings rose and the act stands, or it is undone, the cause is left alone for 6 h and the owner is asked one question with one button (`POST /flow/keeper/answer`).

Where it shows: one line on home and on the boards panel, `keeper` in the MCP `flow` report, the terminal's Flow dialog (the line, the question, and `l` for its one button after a confirm) and its crew scorecard ("Forge per day" rows), and "Forge per day" (hours running, landed) on the crew scorecard and in `scorecard` (`keeperDays`). Every attempt is a row in `keeper_attempt`.

Not done: DORA change-fail rate, revert rate, queue-wait p95 and rework per agent from the issue discussion are not measured yet.

Who reads what: a site admin reads the sentence with repository names and the question with its button. Everyone else, guests and agents included, reads the cause with no repository in it (`readKeeper(db, full)`). The Flow only switch is retired (#7771), so no act asks a question today; one already on the books is answered with its button, and the answer is a `keeper.answered` event carrying the owner's id.
