# Menu

The popup list a §5 **menu** opens. `menu()` in `src/web/ui.ts` draws it; the refs picker (`src/web/pages/refs.ts`)
writes the same parts by hand, and `src/web/client.ts` finds the panel to focus its first item when the menu opens and
to move between items with the arrow keys.

- `.menu-panel` — the raised box under the `<summary>` that holds the `.menu-item`s: absolutely placed, scrolls past
  `min(70vh, 480px)`, end-aligned unless the menu says `data-align="start"`.
- `.menu-item` — one row in the panel: a link, a `<button>` in a POST form, or a `<span>` when disabled; icon, a
  `.grow` label that ellipsizes, and a trailing check on the current one. Muted background on hover and
  `:focus-visible`; `aria-current="true"` sets it heavier; `aria-disabled="true"` dims it, refuses the pointer, keeps no
  hover, and lets its label wrap over the `<small>` reason.
- `.menu-title` — a small uppercase heading over a group of items (`menu({ title })`, "Branches" and "Tags" in the refs
  picker); text only, never focused.
- `.menu-sep` — an `<hr>` between groups (`{ separator: true }` among `menu()`'s items): one border line.
