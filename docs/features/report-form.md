# The report form for outsiders

Anyone may tell a public repository something is wrong at `/<owner>/<name>/report`, with no account.

- **Two lines.** Above the form: who reads the report (a person who maintains the repository, before anything acts on it) and what sending gives you (a link). Words: `src/actions/report_words.ts`.
- **The sent link.** Sending redirects to `/<owner>/<name>/report?sent=<id>`. It shows "Not read yet" until a person decides, then either the issue it became or that it was closed without one. It never shows the report's text or any reply.
- **The limit.** One source may send `report.per_source` reports a minute (default 5); the next gets 429 with `Retry-After`. Set it on the limits page or the `limits` tool; it is read on every report, so a change applies at once. Per-repository and per-forge caps stay in `src/actions/reports.ts`.
- **Terminal.** None for outsiders: the terminal needs an account. Signed-in people report from a repository's `:` palette (`src/tui/screens/report.ts`) and read waiting reports on the reports page.
