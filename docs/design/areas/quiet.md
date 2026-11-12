# Quiet pages

The rules of the quiet-page redesign (#8719) that a machine can check. `bun scripts/design-lint.ts` holds them in
markup and style, never in a paragraph's words. What already breaks one on main is the debt in
`docs/design/quiet-debt.json`, per file and rule; a pull may not raise it, and a paid debt must be struck
(`bun scripts/design-lint.ts --update`), so the list only shrinks.

- `label` — a "Status:" or "State:" label straight before a status word, a tag or an interpolation. Status is one
  small glyph and colour, its word on hover and on the detail page.
- `caps` — `text-transform: uppercase` in a stylesheet. Size and weight carry hierarchy, not small uppercase captions.
- `echo` — an `<a>` or `<button>` holding an icon whose `aria-label` is the same as its visible text. An icon never
  repeats its own label: keep the label and hide the icon, or keep the icon and its aria-label.
- `inline-colour` — a colour name in a `style=""` attribute. Colour is a token (`var(--…)`); hex and `rgb()` literals
  anywhere in `src/web` are already refused by the colour count.
- `keyhint` — a `keyHint(` call or `<kbd class="keyhint">` that is not inside a menu item (#8930). A shortcut never
  takes layout space beside a button, tab or the top bar: the element carries `hintAttr(key)` (`data-hint`), which shows
  as a tooltip on hover or focus and as an overlay while Option is held, and never on touch. Only a menu or palette row,
  which has a column for it, draws the `<kbd>`.

- `banner` (#10699) — `role="alert"`, a `.banner` or a `.notice-danger` in the home and board builders (`board.ts`, `boards-view.ts`, `studio/home*.ts`, `alarm_lines.ts`), zero allowed. A setting that is off is one line on its own page and the system page; only a transient flash (its tag carries `data-flash`) may alert.
- `test/calm-banners.test.ts` renders `/` and `/board` for an admin on a healthy forge and with egress in report mode: neither carries an alert; the fault is one line on Capacity and System.
