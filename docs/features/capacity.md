# Capacity flags a count set below its ceiling (#9049)

A capacity count (`crew.concurrency`, `checks.concurrency`, `queue.depth` and the rest) that an admin has set **below its default** holds the forge back, and nothing used to show it. Now:

- **Settings → Usage → Capacity** puts a "below ceiling N" badge beside the key, N being the default in force (`belowCeiling` in `src/core/capacity.ts`). A value at or above the ceiling, a word-valued key such as `cells.egress`, and a key with no stored value are not flagged.
- **The terminal's Capacity screen** prints "below ceiling N" in the same row's meta line.
- **The pace sentence** (Home, the terminal dashboard and Usage → Spend) says "Crew concurrency is set to X, below its ceiling of Y" while `crew.concurrency` is lowered, so the cap is not mistaken for pacing.

**Reset:** the row's **Put back** button is the reset. It is one same-origin POST to `/settings/capacity` with `reset=1`, it takes effect on the next pick, and it is logged under Changes like any other capacity change.
