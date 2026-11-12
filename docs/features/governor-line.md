# The governor's line

The crew card (studio and repository crew page) and MCP `crew` (`governor.says`) say in one line what the slot governor last did and why: "Builders 7 → 3 at 20:41: 9 opened vs 2 landed", or "Builders back to 7 at 21:30" (UTC). Nothing is said until the slot count has changed once: the first reading is only a baseline.

The tick (`announceGovernor`, src/crew/governed.ts) feeds each reading through `governorStep` (src/crew/governor_log.ts) and keeps the result in the `governor_last` table of the app's sqlite file, so a restart keeps it.

## Where to read it

- Page: the crew card's one Governor row (repository page and crew page) shows the line while the governor holds the crew below its slots; otherwise the current reason, and after a release "Builders back to 7 at 21:30" followed by the reason. It is one row, so the reason is not said twice.
- MCP: `crew` returns `governor.says` (empty until a change) beside `governor.why`.
- Terminal: the dashboard's repository row shows the same line (`governorLine`, src/crew/governed.ts) while the crew is held.

Deleting a repository deletes its `governor_last` row.
