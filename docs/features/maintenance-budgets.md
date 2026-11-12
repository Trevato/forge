# Maintenance duty budgets (#11206)

Each maintenance duty (`src/maintain/registry.ts`) declares a budget: runs per day and dollars per day, with the reason for those numbers. A duty at either budget is skipped for the rest of the UTC day; the runner records one row that day saying which budget it stopped at ("budget: runs per day, 2 of 2 used"). That row is not a run and does not count against the budget or move the interval. The next UTC day the duty runs again.

A budget is a setting, not a constant: an admin's stored value (`forge_setting`, `maintain.<duty>.runs|dollars`, every change in `forge_setting_change`) wins over the duty's declared number. A value equal to the declared one, or a blank, deletes the stored row, so a later change to a duty's declared default still takes effect.

Both doors are for a forge admin who is a person, and call `setBudget` in `src/maintain/budget.ts`.

- **On the web.** `/maintenance`: each duty's row carries what it used today, the reason, and the two inputs (`POST /maintenance/budget`, admin only, same-origin only; a number outside what a budget takes is refused and nothing changes).
- **In the terminal.** Ctrl-K, **Set a maintenance duty's budget**: `j`/`k` choose, `+`/`-` runs per day, `]`/`[` dollars per day, `0` back to the duty's own, Esc closes.

Tests: `test/maintain.test.ts` (the stops, the stored values, the POST gates, the terminal screen).
