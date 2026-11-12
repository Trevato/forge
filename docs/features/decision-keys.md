# Lists that ask for a decision answer the same keys (#10710)

The asks inbox (`/asks`), a repository's issues and its pulls are `data-nav` lists on the web, and list screens in the terminal.

| Key | Web | Terminal |
| --- | --- | --- |
| `j` / `k` | focus the next / previous row | move the cursor (`ListState`, `src/tui/screens/common.ts`) |
| `Enter` or `o` | open the focused row | open the row |
| `Esc` | on the opened page, return to the list and focus the row you opened | `esc` / `q` is back (`src/tui/app/app.ts`) |
| `?` | opens the one help sheet on the first press | the screen's key legend |

- The terminal already has these: the dashboard's asks pane (`dashboard.ts`) and the issues and pulls list (`issues.ts`, one screen for both kinds) are `ListState` lists, so this change adds no new screen.
- The place is kept in `sessionStorage` (`nav-from`, this tab only). A malformed or off-site value is ignored.
- Esc closes the thing on top first: hints, an open menu, a dialog or the help sheet, and a field's own Esc. Only then does it leave.
- Tests: `test/keys-decide.test.ts` drives the real script in a DOM.
