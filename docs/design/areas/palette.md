# Jump to anywhere

The command palette is the keyboard-first fuzzy-find overlay (`⌘K` / `Ctrl K`, or the topbar's search button): the §5 `.palette` dialog, with its input, list and foot drawn by `layout.ts` and its results drawn by `openPalette()` in `src/web/client.ts`. Without script it degrades to `/search`. The file finder (`openFinder()`, `.dialog.palette.finder`) draws its rows and its empty note with the same classes. The rules live in `style/components.ts`.

- `.palette-group` — one group of results under a heading (Recent, Go to, a category); consecutive groups sit 4px apart.
- `.palette-heading` — a group's small, uppercase, faint heading; the group's `aria-labelledby` points at it.
- `.palette-item` — one result row: an icon, the title truncated on one line, and its category pushed to the end. The row the keyboard or pointer has selected (`aria-selected="true"`) carries the one highlight; the finder keeps plain hover.
- `.palette-empty` — the note centred in the list when nothing matches the query.
- `.palette-input` — the search field across the top of the dialog: full width, borderless but for a rule beneath it, 48px tall, with no focus ring of its own (the system outline under forced colours).
- `.palette-list` — the scrolling results area under the input: a fixed height (not a ceiling) so the dialog does not jump as rows come and go.
- `.palette-foot` — the faint one-line strip of key hints under the list, set off by a rule above it.

Dismissal and the phone: a click or tap on the backdrop closes the palette (a drag that began inside does not), and the page behind does not scroll. Under 720px the dialog is a sheet pinned to the top of the visual viewport (`--vv-top`, `--vv-h`, set by `openPalette()`), so the keyboard shrinks it; the input is 16px, rows 44px, and the foot trades its key hints for a link-variant `[data-palette-close]` button. No new class.

The palette's tell row (`data-tell`, last in the list) sends the typed sentence to `/tell`. Its answer is one `.toast[data-palette-tell]` at the top of `#main`, drawn by `tellFromHere()` in `src/web/client.ts` from existing parts only: `.toast` and `.toast-body`, a link-variant small `.btn` as the dismiss ×, and focus moved to the toast (`tabindex="-1"`, `role="status"`) because the palette that held it has just closed. It clears itself after 12 seconds. No new component class.

## Keys beside their actions

An action's shortcut takes no room at rest (#8930, changing the "beside the action" rule of #8709). `btn`, `tabs`, the top bar, the feed's Dismiss and the review verdicts carry `data-hint` (`hintAttr()` in `ui.ts`); a `::before` draws it as a tooltip on hover or focus, and over every action while Option is held or after `?` (`html[data-hints]`, set by the shell script; Escape or a second `?` clears it). It is an overlay: nothing moves, and on touch-only screens it is not drawn. `.keyhint`, the inline `<kbd>`, stays only in menu items, where a column holds it; design-lint's `keyhint` rule refuses it elsewhere. A second `?` opens the help, which lists every key.
