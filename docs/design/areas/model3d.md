# 3D models

The blob page's 3D view (`src/web/render/model3d.ts`), drawn for an STL, OBJ or glTF file.

- `.model3d` — the view, with no box: a `.model3d-head` under a hairline carries a `dl` row (format, file size, then triangles and box once drawn) and the Wireframe and Axes toggles.
- `.model3d-tools` — the two toggles at the end of the head: `btn` with `pressed` (`aria-pressed`) and `js-only`. Hidden until the viewer has drawn the part.
- `.model3d-stage` — the drawing area, held at 4:3 (and at most 70% of the screen's height) before the viewer arrives, so nothing shifts when it does. It carries the empty state (`empty()`, the file icon) with Download until the canvas replaces it, and keeps it when there is no JavaScript or WebGL.
