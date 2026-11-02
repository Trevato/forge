# CSV view

New classes, all in `src/web/style/content.ts`, drawn from existing tokens:
`.csv-view` (the card around a table), `.csv-tools` (filter row, shown only when script runs),
`.csv-scroll` (the scrolling box that holds the sticky header), `.csv-sort` (the real button inside each sortable header), `.csv-more` (the "Showing N of M rows" line).
The table itself is the existing `.table` with `data-dense` and `data-sticky-lead`.
