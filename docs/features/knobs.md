# Knobs

Five dials for the crew, on **Settings › Crew** (admin), in the terminal's palette (`Knobs`; `e` turns the one under the cursor) and in the MCP `knobs` tool, in the same words (#10461).

1. **Speed**: crew runs at once (`crew.concurrency`).
2. **Weekly budget**: percent of the week to use (`week.use`, default 90); the rest is the reserve the pacer keeps.
3. **Polish share**: percent of the week's spend polish may take (`polishShare`, applied to every repository the crew works).
4. **Autonomy**: per repository, `off`, `ask` (plans need a nod, decisions come to you) or `go` (the decider answers, plans open).
5. **Feedback first**: always on; shown, not tuned.

A change applies on the next pump and leaves the event the setting's own page leaves (`capacity.changed`, `repo.settings_updated`).
Not done: the per-repository dollar ceiling (`autonomyCeilingUsd`) and `reserve.ts`'s two-per-slot reserve still stand.

The pipeline's own dials (`queue.depth`, `pace.floor`, `slots.smallShare`, `polish.capMinutes`) are untouched: they stay on the capacity page and nothing in the panel derives them. Only `week.use` is new, and a stored or `FORGE_WEEK_USE` value is read as the budget; no stored value is dropped.
