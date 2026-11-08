# Waves

## The waves page at 390 px (#9325)

`/:owner/:name/waves` lists waves as `listCard` rows. A wave's headline is the
writer's words, so inside `[data-waves]` (an attribute, not a class) the row's
title and meta wrap and break long words anywhere, in place of the list's
one-line ellipsis. No fixed width; the page does not scroll sideways. No new
class. The owner's phone look of `/preview-admin/sample/waves` is attached to
the pull from its preview.

## The list reads as headlines (#9649)

The page's `<h1>` is `sr-only` "Waves"; the list is the shared `.list` of
`row()`s with no card and no heading over it. A row is the headline, the first
highlight's why as the one sentence under it (omitted when empty), and
`version · date · N pulls` as a muted trail. No tooltip repeats it. No new
class and no CSS beyond the wrapping above. The terminal's waves screen
(`src/tui/screens/waves.ts`) is unchanged.
