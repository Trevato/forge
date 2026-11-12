# The crew line on Home

One short line under Home's header, for the owner (a site admin) only, on the web and in the terminal's dashboard. Both print the same words from `crewLineWords` (`src/crew/week_read.ts`):

> 41% of the week left, runs out Thu 14:00 UTC at this pace

- **Percent**: the share of the subscriptions' week still unspent, as the meter reads it, rounded and held to 0-100.
- **Run-out time**: when the pacer's own `runsOutAt` says the current burn empties the week. Always UTC, written `Day HH:MM UTC`.
- **"lasts to the reset at this pace"**: the burn would not empty the week before it resets, so there is no run-out time.
- **Absent** while the week is unmeasured (no account metered, or the reset is past or over a week off): the line says nothing rather than guess. The sentence below it then says the pace is unknown.
- It reads the repository the crew works most, the same one the long week sentence reads (`busiest` in `week_read.ts`), so the two cannot disagree.

The sentence under it (`weekBlock`, `besideCrewLine` in `src/crew/week.ts`) keeps the pace verdict, burn, slots and efficiency but drops the percent and run-out time, so each figure is said once. Both lines are `small muted break` and read as one block. The Spend tab, which has no crew line, keeps the full sentence. While the week is unmeasured there is no crew line and the full sentence stands alone.
