# Knobs

Five dials for the crew, on **Settings › Crew** (admin), in the terminal's palette (`Knobs`; `e` turns the one under the cursor) and in the MCP `knobs` tool, in the same words (#10461).

1. **Speed**: crew runs at once (`crew.concurrency`).
2. **Weekly budget**: percent of the week to use (`week.use`, default 90); the rest is the reserve the pacer keeps.
3. **Polish share**: percent of the week's spend polish may take (`polishShare`, applied to every repository the crew works).
4. **Autonomy**: per repository, `off`, `ask` (plans need a nod, decisions come to you) or `go` (the decider answers, plans open).
5. **Feedback first**: always on; shown, not tuned.

A change applies on the next pump and leaves the event the setting's own page leaves (`capacity.changed`, `repo.settings_updated`).

## Derived from Speed

`pace.floor` (half of Speed, at least 1) and `queue.depth` (half of Speed rounded up, 1 to 4) follow Speed until someone sets them on **Settings › Capacity**; a stored value always wins and nothing stored is dropped. While they follow, the Speed row (page, terminal, MCP) says `(derived from Speed)` beside each, and the capacity page and its terminal screen mark the row `derived`. Because the floor was a fixed 2 before, an install with no stored floor now gets half its Speed (Speed 10: 5). That is a deliberate move of the default pace; set `pace.floor` to keep the old number.

`week.use` is new; a stored or `FORGE_WEEK_USE` value is read as the budget.
