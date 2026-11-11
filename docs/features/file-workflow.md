# A GitHub Actions workflow opens as its jobs

A file under `.github/workflows/` ending `.yml` or `.yaml` opens as what it does instead of raw YAML. Source is one tap away (`?view=source`), and Raw is beside it.

- **Triggers:** the `on:` triggers in one line at the top.
- **Jobs:** one block per job, titled with its id (and `name`). Its runner (`runs-on`), `needs` and matrix (one entry per axis; `include` and `exclude` as a count) show as fact rows.
- **Steps:** a two-column table, one row per step: its name, and what it does (`uses …`, else the first line of `run`).
- **Fallback:** a file that is not valid YAML, holds several documents, is not a map or has no `jobs` shows as YAML with one line saying why.
- **Cap:** at most 100 jobs and 200 steps per job, then a `more … not shown` line. Files over 1 MB keep Source. Values are cut at 300 characters.
- **Terminal:** the workspace screen opens a workflow as a table (job, kind, value: triggers, then each job's runs-on, needs, matrix and steps), with the same fallback reason; `s` shows the source.
- `${{ … }}` expressions show as written; nothing is evaluated. Every value is escaped, drawn on the server; no script, no new CSS, no dependency.

Code: `src/web/render/workflow.ts`, `src/web/render/kinds.ts`, `src/tui/screens/workspace.ts`. Test: `test/render-workflow.test.ts`, `test/blob-workflow-page.test.ts`, `test/tui-workspace.test.ts`.
