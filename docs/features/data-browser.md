# Data browser (core)

`src/data/` reads SQLite files a viewer may see. Reach it at `/data` (the Data button on Apps, for an admin or an app's writer), in the terminal as the palette command Data, or through the MCP tool `data`. An admin or a writer of an app gets the page (an empty state until a database exists); a guest or a reader gets a 404, no palette entry, and nothing from the tool.

- `listSources(db, dataDir, viewer)` — `forge.db` for admins; for each app the viewer can write, every `.db` under each environment's data dir. `findSource` resolves an id only through that list, so a reader gets `undefined` (a 404), and no input becomes a path.
- `tables(source)`, `rows(source, table, {filter, order, page})` — 50 rows a page; table and column names are checked against the schema.
- `query(source, sql, timeoutMs?)` — one `SELECT`/`WITH`, read-only connection (`query_only`), 1,000 rows, 5 s. It runs in a worker that is terminated at the cap, so even a query that never yields stops.
- Masking (`mask.ts`): columns named like token, secret, password, hash, sealed, key, cookie, … show `••••••`. Queries read through temporary views that shadow each table, so aliases and subqueries are masked too; `main.` qualifiers are refused. Masked columns cannot be searched or ordered. `ALLOW` lists `table.column` exceptions per source id.
- Connections open per call and close after; they never take a writer lock.

Views are masked whole when their text mentions a masked column (an alias cannot launder a secret). `FORCE` masks generic columns by source (`forge_setting.value`, …); `test/data-browser.test.ts` audits every `forge.db` column against the name rule and lists the ones reviewed as clear.

Limits on work: `query` runs at most 2 workers at once (a third is told it is busy), each with a 128 MB heap cap (`hard_heap_limit`), a 5 s timer, 1,000 rows and about 250 KB of result; every cell is cut to 1,000 characters inside SQLite and a blob shows as its size. `rows()` cuts cells the same way.

Terminal: `src/tui/screens/data.ts` (files → tables → rows, `n`/`p` for pages), offered by `maySeeData`.

Not done: a SQL editor on the page or in the terminal (SQL is MCP only).
