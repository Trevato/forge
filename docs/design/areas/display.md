# Display

A repository's display, `/:owner/:name/display` (`src/web/pages/display.ts`): the builds its `display.json` holds, as a dense table (`.table`, `.table-scroll`) under the repo header, as whoever looks may read them. It adds no component class. Covers, the player and editing the title wait for `pin_demos.ts`.

Writers also get a form of `.field` fieldset, `.check` rows, a `btn` and a `.hint` status line: no new component class.

On the display titled `arcade-builds` in the shelf layout the page head carries **Launch**, a plain link (`.btn`) to the Arcade host (`arcade.<app domain>`, `src/arcade/host.ts`). The host page is its own document, outside the forge's design system: pixel look, no third-party fonts, focus to `#back` when a cart opens and back to its cart when it closes, prev/next buttons for carts off the front, a touch hint under `(hover: none)`, and a `<noscript>` line.
