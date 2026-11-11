# An lcov coverage file opens as its coverage

`bun test --coverage-reporter=lcov` and `geninfo` write lcov tracefiles. A file named `lcov.info` (or `*.lcov`) opens as a table instead of raw text; Source is one tap away.

- **Totals** at the top: lines, functions and, when any record has them, branches, as hit over found.
- **One row per source file** (`SF:`), worst line coverage first, ties by path: a `<meter>` bar, then lines (`LH`/`LF`), functions (`FNH`/`FNF`) and branches (`BRH`/`BRF`) as `hit/found · percent`. A record with no `LF`/`LH` counts lines from its `DA:` entries.
- **File** links to that file (same repository, same ref) when the path is plain relative and exists at the ref; otherwise it is text.
- **Cap:** at most 5,000 files are drawn; the page says how many were left out.
- **Fallback:** a malformed file (missing `end_of_record`, `LH` above `LF`, a counter outside a record) shows Source with the reason.
- Every string is escaped. No script, no new CSS: it uses the `table` and `meter` components.

**Terminal:** opening an lcov file in the workspace shows File, Lines, Functions and Branches, worst first, "N files" in the status line (`lcovTable` in `src/tui/screens/workspace.ts`, over the same `parseLcov`); `s` flips to the source.

Code: `src/web/render/lcov.ts`, `src/tui/screens/workspace.ts`. Tests: `test/render-lcov.test.ts`, `test/tui-workspace.test.ts`.
