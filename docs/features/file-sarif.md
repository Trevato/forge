# A .sarif file opens as its findings

Security scanners (CodeQL, Semgrep, eslint) write SARIF. A `.sarif` file in a repository opens as a list of findings instead of raw JSON; Source is one tap away.

- **Counts** at the top: errors, warnings, notes, none. A result with no `level` counts as a warning (SARIF §3.27.10).
- **One table per run**, headed by the tool's name (`tool.driver.name`). One row per result: level, rule id, `file:line`, message.
- **Location** links to that line (`#L12`) in the same repository at the same ref when the URI is a plain relative path. The page checks the file exists at the ref (the ref's file list); a missing file, or a listing too long to read in full, shows plain text. Absolute, `file:` or `..` URIs are shown as text.
- **Cap:** at most 1,000 results are drawn across all runs; the page says how many were left out. Files over 5 MB keep Source.
- **Fallback:** invalid JSON, or no `runs` array, shows Source with the reason.
- Every string is escaped. No script, no new CSS (`.sarif-view` is a hook with no rule).

**Terminal:** opening a `.sarif` in the workspace shows a table of level, rule, location, message and tool (`sarifTable` in `src/tui/screens/workspace.ts`, over the same `parseSarif`), "N findings" in the status line; `s` flips to the source. Locations are text there.

Code: `src/web/render/sarif.ts`, `src/tui/screens/workspace.ts`. Tests: `test/render-sarif.test.ts`, `test/tui-workspace.test.ts`.
