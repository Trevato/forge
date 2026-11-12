# The empty palette lists what you opened last

Open the command palette (Cmd/Ctrl K, or the phone search sheet) and type nothing: the first group, "Recent", holds at most five rows, then the usual rows follow. The pages you visited come first, newest first; when fewer than five, rows you picked before fill the rest, ordered by frecency. Each page is listed once (a page both visited and picked sits where its visit puts it), and never the page you are on (`palettePool`, `src/web/palette.ts`).

- **Visits:** paths only, kept in `localStorage` (`forge.palette.visits`), never titles: a title is looked up from the palette's own rows. Only a page the palette has a row for is recorded, so error and login pages never are (`recordVisit`, `visitLoad`, `visitRows`). Logging out does not clear the list: it lives in the browser, so on a shared machine clear site data.
- **Frecency:** each opening counts one, halved for every week since the last. A row opened often and a row opened just now both lead a row opened once long ago (`frecencyOrder`).
- **Local:** the picked rows live in this browser's `localStorage` (`forge.palette.recent`). Nothing is sent to the server, and clearing site data clears both lists. Storage is read once each time the palette opens, not per keystroke.
- **Limits:** 50 picked rows are kept (the least useful falls off when a 51st is opened); the Recent group shows at most five. Typing hides it and searches everything as before.
- **Older lists:** entries saved before counts existed read as one opening.
- **Terminal:** the terminal's palette (`src/tui/`) has its own ranking and no browser storage; it is out of scope here, because both lists are browser storage.

Recording and reading are the pure `recordUse` and `readUses`; they ride in the shell script with the other palette helpers. Tests: `test/palette.test.ts`, including the shell itself run in happy-dom (a load records its page, the next page's palette opens on it, typing reads no storage).
