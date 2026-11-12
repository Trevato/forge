# Scrape evidence (#9406)

An admin sees what was read and works out who is doing it, at `/settings/traffic/scrapes` (linked from Traffic) and in the terminal: `:` → "Scrapes" (a forge admin who is a person; read-only there).

- **Reads.** For 1, 3 or 7 days: per repository, the paths read, the commits and branches, how much of the repository was covered, and files whose names look like keys or credentials. Counted in memory as requests finish (`perf/reads.ts`), written once a minute to `read_hour`, kept 7 days. No address is kept in it. A stored hour holds at most 500 distinct (repository, ref, path) rows; later ones fold into `(others)` for their repository, so an attacker walking paths cannot grow the table, and the report groups in SQL.
- **Networks.** Address prefixes show name, operator, country and abuse contact from the forge's own `network` table, filled by pasting `range, name, operator, country, abuse contact` lines. No visitor address goes to a third party. Where the table has no entry, the page says the evidence stops there.
- **Capture.** One click starts a capture: 10 minutes, 2000 requests, in memory only, no cookies, tokens or query strings, signed-in people skipped. Requests that look alike are grouped across addresses with a stated confidence and reasons. Full addresses exist only inside a capture and are gone when it expires or is stopped.
- **Bot score and country** (`cf-bot-score`, `x-bot-score`, `cf-ipcountry`) are believed only when the request came through a trusted proxy (`peer.ts`, `wasViaEdge`); from anyone else they are ignored.
- **Export.** A group exports as a plain-text abuse report with its limits stated.
- Admin only; agent accounts are refused; every mutation is same-origin.

Not done: lookups against a public registry (by design, nothing leaves the forge), and blocking from this page.
