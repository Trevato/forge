# Data browser (core)

`src/data/` reads SQLite files a viewer may see. Reach it at `/data` (the Data button on Apps, for an admin or an app's writer), in the terminal as the palette command Data, or through the MCP tool `data`. An admin or a writer of an app gets the page (an empty state until a database exists); a guest or a reader gets a 404, no palette entry, and nothing from the tool.

- `listSources(db, dataDir, viewer)` — `forge.db` for admins; for each app the viewer can write, every `.db` under each environment's data dir. `findSource` resolves an id only through that list, so a reader gets `undefined` (a 404), and no input becomes a path.
- `tables(source)`, `rows(source, table, {filter, order, page})` — 50 rows a page; table and column names are checked against the schema.
- `query(source, sql, timeoutMs?)` — one `SELECT`/`WITH`, read-only connection (`query_only`), 1,000 rows, 5 s. It runs in a worker that is terminated at the cap, so even a query that never yields stops.
- Masking (`mask.ts`): columns named like token, secret, password, hash, sealed, key, cookie, … show `••••••`. Queries read through temporary views that shadow each table, so aliases and subqueries are masked too; `main.` qualifiers are refused. Masked columns cannot be searched or ordered. `ALLOW` lists `table.column` exceptions per source id.
- Connections open per call and close after; they never take a writer lock.

Views are masked whole when their text mentions a masked column (an alias cannot launder a secret). `FORCE` masks generic columns by source (`forge_setting.value`, …); `test/data-browser.test.ts` audits every `forge.db` column against the name rule and lists the ones reviewed as clear.

Limits on work: `query` runs at most 2 workers at once (a third is told it is busy), each with a 128 MB heap cap (`hard_heap_limit`), a 5 s timer, 1,000 rows and about 250 KB of result; every cell is cut to 1,000 characters inside SQLite and a blob shows as its size. `rows()` cuts cells the same way.

Terminal: `src/tui/screens/data.ts` (files → tables → rows, `n`/`p` for pages, `s` sort, `f` filter, `c` clear, `x` read-only SQL), offered by `maySeeData`; the forge's own database is among an admin's files. SQL on either door is 20 runs a minute per person (`src/data/sql_window.ts`); beyond that it says when to retry.

## On the web (#7580)

Three doors, one body (`src/web/pages/data_view.ts`): `/data` (every file you may see), `/admin/data` (the forge's own database, admins; the Forge data button on `/data`) and `/:owner/:name/data` (an app's Data tab for its writers: environments → files → tables → rows; a reader gets the 404). Rows sort by header (`sort`, `dir`), filter by text on one column or all (`q`, `col`), JSON cells are pretty-printed, and a copy button per row puts it on the clipboard as JSON. Sealed columns show `••••••` and cannot be sorted or searched. The SQL box is a GET form (`sql`, capped at 4,000 characters), so a query is an address to share; it shows the rows and the elapsed ms. The sorted column carries `aria-sort` and a muted arrow from CSS; a wide grid scrolls sideways only. Not done: saved queries, export, editing rows.
