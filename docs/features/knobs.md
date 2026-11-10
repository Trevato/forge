# Knobs

Five dials for the crew, on **Settings › Crew** (admin), in the terminal's palette (`Knobs`; `e` turns the one under the cursor) and in the MCP `knobs` tool, in the same words (#10461).

1. **Speed**: crew runs at once (`crew.concurrency`).
2. **Weekly budget**: percent of the week to use (`week.use`, default 90); the rest is the reserve the pacer keeps.
3. **Polish share**: percent of the week's spend polish may take (`polishShare`, applied to every repository the crew works).
4. **Autonomy**: per repository, `off`, `ask` (plans need a nod, decisions come to you) or `go` (the decider answers, plans open).
5. **Feedback first**: always on; shown, not tuned.

A change applies on the next pump and leaves the event the setting's own page leaves (`capacity.changed`, `repo.settings_updated`).

## Derived from Speed

`pace.floor` (half of Speed, at least 1) and `queue.depth` (half of Speed rounded up, 1 to 4)
are computed from Speed every time they are read. They show with their value, read-only, on
the knobs panel and under Settings › Capacity; a POST that tries to set one is refused with
a plain line, and `FORGE_PACE_FLOOR`, `FORGE_QUEUE_DEPTH` and any stored value are ignored.
Reserve shows as a read-only row after Weekly budget: it is what Weekly budget leaves (100
minus `week.use`), so it moves with that dial, not with Speed. A set is refused with the plain
line "That dial follows Weekly budget: turn Weekly budget and it moves."; nothing is stored. The small share and the polish run cap are gone; a
stored old value is ignored.

`week.use` is new; a stored or `FORGE_WEEK_USE` value is read as the budget.
