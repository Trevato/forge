# Command palette

The command palette is the keyboard-first fuzzy-find overlay (`⌘K` / `Ctrl K`, or the topbar's search button): the §5 `.palette` dialog, with its input, list and foot drawn by `layout.ts` and its results drawn by `openPalette()` in `src/web/client.ts`. Without script it degrades to `/search`. The file finder (`openFinder()`, `.dialog.palette.finder`) draws its rows and its empty note with the same classes. The rules live in `style/components.ts`.

- `.palette-group` — one group of results under a heading (Recent, Go to, a category); consecutive groups sit 4px apart.
- `.palette-heading` — a group's small, uppercase, faint heading; the group's `aria-labelledby` points at it.
- `.palette-item` — one result row: an icon, the title truncated on one line, and its category pushed to the end. The row the keyboard or pointer has selected (`aria-selected="true"`) carries the one highlight; the finder keeps plain hover.
- `.palette-empty` — the note centred in the list when nothing matches the query.
- `.palette-input` — the search field across the top of the dialog: full width, borderless but for a rule beneath it, 48px tall, with no focus ring of its own (the system outline under forced colours).
- `.palette-list` — the scrolling results area under the input: a fixed height (not a ceiling) so the dialog does not jump as rows come and go.
- `.palette-foot` — the faint one-line strip of key hints under the list, set off by a rule above it.

The palette's tell row (`data-tell`, last in the list) sends the typed sentence to `/tell`. Its answer is one `.toast[data-palette-tell]` at the top of `#main`, drawn by `tellFromHere()` in `src/web/client.ts` from existing parts only: `.toast` and `.toast-body`, a link-variant small `.btn` as the dismiss ×, and focus moved to the toast (`tabindex="-1"`, `role="status"`) because the palette that held it has just closed. It clears itself after 12 seconds. No new component class.

## Keys beside their actions

`.keyhint` is the `<kbd>` of an action's shortcut (`keyHint()` in `ui.ts`); `btn`, `tabs`, menu links, the top bar and the review verdicts render it for every `data-shortcut`. It is hidden on phone widths and on touch-only screens (`pointer: coarse`), where there is no keyboard.
