# Command palette

The command palette is the keyboard-first fuzzy-find overlay (`⌘K` / `Ctrl K`, or the topbar's search button): the §5 `.palette` dialog, with its input, list and foot drawn by `layout.ts` and its results drawn by `openPalette()` in `src/web/client.ts`. Without script it degrades to `/search`. The file finder (`openFinder()`, `.dialog.palette.finder`) draws its rows and its empty note with the same classes. The rules live in `style/components.ts`.

- `.palette-group` — one group of results under a heading (Recent, Go to, a category); consecutive groups sit 4px apart.
- `.palette-heading` — a group's small, uppercase, faint heading; the group's `aria-labelledby` points at it.
- `.palette-item` — one result row: an icon, the title truncated on one line, and its category pushed to the end. The row the keyboard or pointer has selected (`aria-selected="true"`) carries the one highlight; the finder keeps plain hover.
- `.palette-empty` — the note centred in the list when nothing matches the query.
