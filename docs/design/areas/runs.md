# Runs

- `.row-note` — free text an agent wrote (a run's summary, or a word's note taken from one) inside a §5 row's meta: one line clamped by CSS with an ellipsis, whitespace collapsed, escaped, never rendered as markdown, its whole text in `title`, and narrower than the meta so the who and when after it stay visible (#73). Written by `noteLine()` in `src/web/studio/note.ts` (the runs list, *Now*, a tell's runs, a planner's decline quoted on an ask's line and a decider's why in the board's decision ledger; #10199). Styled in `src/web/style/components.ts` (list rows).
- `.check-words` — the run page's live tests line under the step list: reserves one line of height (1.4em) so the pin slot and log never move as the words arrive.

## A run's page at 390 px (#9347)

`/:owner/:name/runs/:id` fits a 390 px phone. The head (`#run-head`: title,
the issue it is about, summary, carries) and the live region (`#run-live`)
break a long word anywhere (`RUN_PAGE_CSS`, `src/web/pages/runs.ts`, shipped
as the page's own style), so a pasted path or a 300-character token wraps in
place. The log box (`.run-log`) already wraps its lines and scrolls inside its
own bounds. No fixed width; the page does not scroll sideways. No new class.

See it on a phone: `/preview-admin/sample/runs/<id>` renders a sample run's
page; at 390 px the head and live region wrap in place. That is asserted from
the HTML and CSS (`test/run-page-fit.test.ts`), not from a 390 px render.

## Rows and space, not boxes (#9727)

The runs list (`runsListPage`, `src/web/studio/lists.ts`) is a `.card.bare` list: one row per run, its state a
badge, its agent and age in the row's meta, on the page's one background with no frame. A run's log (`.run-log`)
has no box either: no fill, border or radius, just space around its rows, still wrapping and scrolling inside its
own bounds; the steer form under it keeps one hairline above it. Filter, working tab, live tail, refresh, cancel and
the `/runs/:id` door are unchanged. No new class.

The app page's log tail (`.run-log.log-tail`, a peek at a running row's log) shares `.run-log`, so it loses its
frame too. That is intended: a peek under a row reads as part of the row, not a box inside it.

A check run's step list (`#check-steps`) is a `.card.bare` list too, so `/runs/:id` has no boxed card. At 390 px a
log row's only fixed width is its 72px speaker column; the words (`.row-main`, `min-width: 0`) take the rest and
wrap (`test/run-page-fit.test.ts`).
