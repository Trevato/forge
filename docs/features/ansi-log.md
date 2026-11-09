# Terminal logs in colour

`.log` and `.ansi` files that contain terminal escapes open on the blob page in colour (`src/web/render/log.ts`, parser in `ansi.ts`). A log with no escape byte keeps the ordinary source view.
Only SGR is read: foreground colour (30-37, 90-97, and 256-colour 0-15), bold, underline, and the resets 0, 22, 24, 39. Each becomes a fixed class (`ansi-red`, `ansi-b`, `ansi-u`, …) coloured by design tokens; the input never reaches a `style` attribute or a class name. Background, truecolour and 256-colour above 15 are dropped.
Every other escape (cursor moves, OSC titles and links, an unterminated OSC up to its newline) and every other control character, a bare CR included, is removed, never acted on. A colour is closed at each line end and reopened on the next.
Drawn as the code view is: first 1,500 lines, `?all=1` ("Show all lines", no JavaScript) up to 10,000, with an "N more lines" note. `?view=source`, Raw and Download show the bytes untouched.
The terminal (SSH) file view shows a `.log`/`.ansi` as plain text: its escapes are stripped (`stripAnsi`, `src/tui/term/ansi.ts`) before the lines are built, so a log cannot move the cursor, set a title or print `[31m`. It has no colour there. The class list lives in `docs/design/areas/render.md` and `src/web/style/content.ts`.
