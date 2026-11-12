# A tell from a preview's toolbar carries its pull

A tell sent from the forge toolbar of an app or a preview arrives with where it was said.
On a preview the issue's "Where this was told from" block opens with one line,
`from preview of #N, page /x`, in place of the plain page and pull lines.

- **Which doors say it.** The toolbar's tell form (`tellFromPage`, `src/web/studio/actions.ts`)
  and the terminal's "Tell the crew from a page" (`src/tui/screens/tell.ts`), both of which ask for
  a preview's pull. They pass `{ preview: true }` to `contextNote`. The MCP `tell` tool and the
  API keep the plain `- page:` and `- pull:` lines: they never claim a preview.
- **Checked at the boundary.** Page and pull go through `parseContext`; the line is built by
  `previewLine` (`src/actions/tell_from.ts`) from the page's path alone (no host, query or
  fragment), every markup character percent-encoded. It is context, never authority; the
  same-origin check on the POST is unchanged.
- Tests: `test/apps-toolbar-tell.test.ts`, `test/tui-tell.test.ts`, `test/tell-context.test.ts`,
  `test/tell_from.test.ts`.
