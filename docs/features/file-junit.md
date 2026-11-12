# A JUnit XML report opens as its results

Test runners (JUnit, pytest, vitest, Go via gotestsum) write JUnit XML. A file named `*.junit.xml` or `TEST-*.xml`, or any `.xml` whose root is `<testsuites>` or `<testsuite>`, opens as results instead of raw XML; Source is one tap away. Any other `.xml` stays source.

- **Lead line:** one sentence ("2 of 40 tests fail."), then the totals: tests, failures, errors, skipped, time.
- **Per suite:** a heading, then one `.table` (`data-dense`) of failing cases (failures and errors first): case, result and type, message, time. A case's body (stack trace) follows in a `pre`, cut at 40 lines and 8,000 characters.
- **Passing and skipped** cases sit folded in one native `details`.
- **Cap:** at most 2,000 cases are drawn, failing first; the page says how many were left out. Files over 5 MB keep Source.
- **Fallback:** malformed XML, a DOCTYPE (refused, never expanded), nesting or element counts past the bounds, or a root that is not a test report shows Source with the reason.
- The XML reader is its own: no entity but the five predefined. Every string is escaped. No script, no new CSS (`.junit-view` is a hook with no rule).

**Terminal:** opening such a file in the workspace shows a table of result, case and message, headed by a totals row (`junitTable` in `src/tui/screens/workspace.ts`, over the same `parseJunit`), "N failing cases" in the status line; `s` flips to the source. A file that is not a report opens as source with the same reason.

Code: `src/web/render/junit.ts`, `src/tui/screens/workspace.ts`. Tests: `test/render-junit.test.ts`, `test/tui-workspace.test.ts`.
