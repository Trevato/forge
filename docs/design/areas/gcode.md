# G-code layers

The blob page's layer view (`src/web/render/gcode.ts`, styles in `gcode-css.ts`), drawn for a sliced `.gcode` file. It uses the existing tokens (`--fg`, `--border`) and the `btn` and `status-rows` classes.

- `.gcode-view` — the figure, with no box: nav row, the layer's SVG, one caption line, the facts as `status-rows`, Download.
- `.gcode-nav` — Previous, the layer form and Next, wrapping. At 360px the form takes its own line above, and Previous and Next share the line under it, each a `btn` (44px tall, so a thumb hits it). From 640px the three sit in one row. A missing neighbour is a `btn` with `aria-disabled`, so the row keeps its shape.
- `.gcode-form` — the `Layer [n] of N` label, a number input (6em, 44px tall) and Show. A plain GET form: it works without JavaScript.
- The SVG fills the width at its own aspect ratio and is held under 70% of the screen's height; its `viewBox` is set on the server, so nothing shifts.
