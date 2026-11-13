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
- `.menu-note` — a quiet word at the end of an item (`{ note }`): the signed-in name beside "Your profile";
  ellipsized at half the row.
- `.menu-row` — a row that holds a control and goes nowhere: icon, label, then the control (the Theme row's `.seg`).
  Laid out as an item, with no hover.
- `.menu-sep` — an `<hr>` between groups (`{ separator: true }` among `menu()`'s items): one border line.

Under 720px a menu in the topbar is a sheet: the panel spans the bottom edge of the window (measured from the bar to
`100dvh`, so it clears the browser's own bars and the home indicator), items are 44px, and a shade covers the page.
Tab stays inside an open menu; Escape closes it and returns to its button.
