# A `.env.example` opens as the variables an app needs

A file named exactly `.env.example`, `.env.sample` or `.env.template` opens as a table instead of raw text: **name**, **example value** and the **comment** written above the line. Source is one tap away (`?view=source`). A plain `.env` (or `.env.local`, `.env.production`) is never drawn this way and keeps the source view.

- **Value:** shown as written, quotes removed; `—` when empty. A name ending `_KEY`, `_SECRET` or `_TOKEN`, or containing `PASSWORD`, shows `•••` instead of its value, even in an example file.
- **Comment:** the `#` lines directly above a variable, plus an inline ` # note`. `export ` is allowed; `#` inside quotes or a URL fragment is part of the value.
- **Groups:** a `#` block followed by a blank line is a group heading; the variables below it sit under it.
- **Cap:** at most 500 variables, then one line `N more not shown`. Files over 1 MB keep Source. A file with no variable shows Source with the reason.
- Every cell is escaped and the table is drawn on the server. No script, no new CSS (`.env-view` is a hook with no rule).

**Terminal:** the workspace opens the same table (`envTable` in `src/tui/screens/workspace.ts`, over the same `parseEnv`); `s` flips to the source.

Code: `src/web/render/env.ts`, `src/web/render/kinds.ts`. Tests: `test/render-env.test.ts`, `test/tui-workspace.test.ts`.
