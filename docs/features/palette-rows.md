# Palette rows: numbers, people, settings, actions

The palette finds, on a repository's page, `#123` (one row, "Go to #123", built in the browser from the page's own path; issues and pulls share one number space and each address redirects to the other kind, so it never dead-ends on a kind). For signed-in viewers it also carries people, more settings pages and one action, "Tell the crew". A title is found by the forge's own search behind the palette, not by a local list: no issue or pull rides in the page.

Filtered on the server before the list exists (`src/web/palette_rows.ts`, `paletteIndex` in `src/web/layout.ts`): `here` (the page's repository, for `#N`) is sent only when it is public or the viewer may direct its crew; the rest are for a signed-in viewer only. An action row (`a: 1`) is something that sends rather than goes: the first tap or Enter arms it ("Tap or press Enter again to confirm", announced through a polite live region and `aria-description`), the second runs it. Navigation rows, the map and New app among them, never ask.

No terminal screen: the palette is a web surface and has no TUI counterpart.

Tests: `test/palette-rows.test.ts`.
