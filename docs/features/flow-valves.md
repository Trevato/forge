# Flow: the week's budget as pipes

`/flow` (a forge admin; linked from Boards) draws where the week's money goes: your notes, the planner, the builders and reviews on the left, a **valve** per repository in the middle, shipped on the right. Line width is the real spend of the last 7 days (`flow/pipes.ts`).

## A valve

One stored number per repository, 0 to 100 (`flow_valve`): **shut** (0), **a share** of the week's agent starts (1 to 99), or **open** (100, and what a repository without a valve is). Drag the slider and release: that is `POST /flow/valve`, and the next dispatcher tick obeys it (`flow/valve_gate.ts`, called by `pump` in `crew/dispatch.ts`).

The rule is `throughValves` in `flow/valve.ts`, plain data in and out, so the same valves and the same queue decide the same way (`test/flow-valves.test.ts`):

- shut: a queued run waits, and its log says why; a run carrying on after a pause is never held;
- a share: runs start in turn while the repository holds no more than its share (rounded up) of the week's starts, then yield to the other repositories. A share is a ceiling in turn, not a quota: when nothing else wants the slot, the yielding run still starts;
- open: unchanged.

Only a person who is a forge admin turns a valve (`actions/valves.ts`); an agent, whatever it was granted, is told `not_found`. Each turn is kept (`flow_valve_turn`) and announced as `valve.turned`.

## Before and after

Beside each valve the page says what the next tick will do from the queue as it stands ("of 3 queued: 1 starts in turn, 1 yields, 1 stays queued, held by the valve"), and, once turned, who turned it, from what to what, and how many runs have started since.

## Suggestions

Looking at a repository's page as an admin is counted per day (`flow_look`). When your share of looks differs from a valve by 10 points or more, and there are at least 10 looks, the valve shows "You looked here N times this week: 40% would match" with one button. Taking it is a turn you make (`POST /flow/suggestion`; the level is worked out again on the server). Looks never move a valve.

## For an agent

The MCP tool `valves` reads the same pipes; `repo` and `level` plan a turn (`dryRun` is true unless `false`) and apply it with an admin-scope token held by a person.

## In the terminal

The palette's **Valves** (`tui/screens/valves.ts`, a forge admin who is a person; a guest, a member and an agent are offered nothing) lists the same `readPipes` rows. `h` and `l` close and open the valve under the cursor by ten, `x` shuts it, `o` opens it, `t` takes the suggestion; each goes through `turnValveFor` / `acceptSuggestion`, so it is kept and announced as `valve.turned` like a turn on the page. The screen refreshes on that event, so a turn made on the page shows there and the other way round (`test/tui-valves.test.ts`).

`valve.turned` names the repository, so it is for that repository's admins (`core/event_audience.ts`), never for a reader who could not open it.
