# The empty palette lists what you opened last

Open the command palette (Cmd/Ctrl K, or the phone search sheet) and type nothing: the first group, "Recent", lists the rows you opened before, ordered by frecency, then the usual rows follow.

- **Frecency:** each opening counts one, halved for every week since the last. A row opened often and a row opened just now both lead a row opened once long ago (`frecencyOrder`, `src/web/palette.ts`).
- **Local:** the list lives in this browser's `localStorage` (`forge.palette.recent`). Nothing is sent to the server, and clearing site data clears it.
- **Limits:** 50 rows are kept (the least useful falls off when a 51st is opened); 8 are shown while the box is empty. Typing searches everything as before.
- **Older lists:** entries saved before counts existed read as one opening.
- **Terminal:** the terminal's palette (`src/tui/`) has its own ranking and no browser storage; it is out of scope here.

Recording and reading are the pure `recordUse` and `readUses`; they ride in the shell script with the other palette helpers. Tests: `test/palette.test.ts`.
