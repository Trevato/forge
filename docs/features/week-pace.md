# The week's pace (#8695)

The crew spends the subscriptions' week so that it ends empty at the reset.

- **Home** (and an admin's terminal dashboard) carries one sentence under the figures: on pace, ahead or behind, with the target burn a day, and beside it what a real landing cost and how many runs it took this week. Pulls closed as carried (already on the base) are not landings.
- **Behind**, with builders idle and nothing startable, the autonomy tick releases the next issue only the Later gate holds (lowest number first), one per tick, with a log line and a comment on the issue saying why.
- **Ahead**, slots come down in proportion to how far ahead, never below one while the reserve holds.
- **Reserve**: a tenth of the week's crew capacity is held back from the crew: at it, slots go to zero until the reset. That leaves the week's last tenth to conversations and a person's own runs only by the crew standing down; those runs are not otherwise counted against it.

The settings are the plain values in `WEEK` (`src/crew/week.ts`); the decision is a pure function of the figures (`weekDecision`), read from the standing by `src/crew/week_read.ts`. Tested in `test/week.test.ts`.

## Bets (#8713)

Bets are not in the forge yet, so the release above falls back to the lowest-numbered gate-held issue. When bets land, "behind" releases the next scope of a backed bet, or offers the next bet to back, in place of that fallback; the change is the one candidate read in `releaseForPace` (`src/crew/autonomy.ts`). Appetites then sit inside the week's capacity the decision already works out (`capUsd` less the reserve), so no bet's share can exceed it.
