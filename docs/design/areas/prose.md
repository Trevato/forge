# Prose (markdown)

Markdown table cell alignment: a column whose delimiter row reads `:-:` or `--:` puts the matching class on each of its
`th` and `td` cells, written by `cells` in `src/web/markdown.ts` as `ta-${align}` and styled under `.prose` in
`src/web/style/content.ts`. A left-aligned or unmarked column carries no class.

- `.ta-c` — a centred column (`:-:`); text-align center.
- `.ta-r` — a right-aligned column (`--:`); text-align right.

## Image view

- `.imgview` — the card a rendered image or SVG sits in (`src/web/render/image.ts`).
- `.imgview-meta` — its header line: pixel size, file size, format.
- `.imgview-dim` — the slot the browser fills with the pixel size.
- `.imgview-pane` — the checkerboard pane; `.is-actual` shows the image at 100% and pans.
- `.imgview-img` — the image itself, fit to the pane.
- `.imgview-zoom` — the Actual size / Fit toggle in the header line, pushed to its right edge.
