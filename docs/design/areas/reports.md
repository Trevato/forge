# Reports

`/:owner/:name/reports` (`src/web/pages/reports.ts`) is headings over rows: each filer is a
`<section class="settings-block">` with an `<h2>`, each report a `row()` in `<ul class="list setting-list">` whose meta keeps
"From outside, …, not checked" and whose open `fold` holds a `.report-body`; none is a `card()`.
The "Report sent" and "Nothing waiting" notices are plain text. `test/reports-page-shape.test.ts` holds the shape.

- `.report-body`: the open body of a report row. Its message, hint, accept form (title field and button) and dismiss form
  stack as one grid column in reading order, so nothing shares a flex line and nothing scrolls sideways at 390px.
  Its 14px inset matches `.row` padding, so it lines up under the row title (a report row has no lead glyph) at every width. Styled in `src/web/style/components.ts`.
