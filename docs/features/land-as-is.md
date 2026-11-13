# Land it as it is

When the crew cannot go on (its included credit is spent, or it has no model key) a green pull still goes live.

- The pull page and the app's page each say so in one sentence, and offer **Land it as it is** with the preview link beside it, and **Add a key**.
- The button is the pull's own ship action (`POST /:owner/:name/pulls/:n/ship`, same-origin checked, `mergePull` behind it). It is offered only for a pull whose check is green and whose verdict is "Ready to land"; a red pull never shows it.
- MCP: the existing `merge` tool takes `action: "land"` (squash, only while the check is green); its plan carries `crew` with the same sentence.
- Code: `src/web/studio/land_as_is.ts`. Test: `test/land-as-is.test.ts`.
- Terminal: the palette's "<owner>/<name> — Land it as it is" (`src/tui/screens/landasis.ts`) while an open app has a pull to land; Enter lands the pull under the cursor, squashed, as the page's button does. `landable` gives the page, the terminal and MCP the same rows (a writer's, the crew stopped, the check green).
- Only an admin is shown **Add a key**; anyone else is told only the admin can.
