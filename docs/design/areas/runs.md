# Runs

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
