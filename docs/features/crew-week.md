# The week is one budget for the whole crew (#8989)

`crewWeekFor` (`src/crew/week_read.ts`) reads the week once per set of accounts and decides in slots for the whole crew: its ceiling is `crew.concurrency`, its floor (`WEEK.floorSlots`) applies to the crew, not to each repository. `repoPace` gives a repository `budget - slots running in the other repositories on the same accounts`, held under the repository's own slots, which stay limits inside the budget.

- Only new picks wait on it. Finishing, rework and reviews use `repoPace(..., false)` and run ahead.
- `autonomyTick` drives repositories with a backed bet first, so a short budget goes to what the owner backed, then the rest in order.
- A repository that hit its daily ceiling yesterday restarts at its own time in the first six hours of the UTC day (`src/crew/ceiling_stagger.ts`), so the midnight reset is not a burst.
- Home and the terminal print the crew's number: "the week allows the whole crew N of M slots".
- Picks made earlier in the same tick in other repositories count against the budget before their runs show, so a burst across repositories cannot pass the crew's floor.
- A ceiling of 0 allows no spend and is held by the ceiling itself; it is never also held until an offset. The "hit yesterday" read is remembered per repository for one instant, so `repoPace` runs it once a tick.
- Work a person assigns starts through the dispatcher, which does not read `repoPace`, so it is not held by the crew's budget.
