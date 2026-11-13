# A .dxf file as a picture

A `.dxf` file (AutoCAD drawing exchange, ASCII) opens on its blob page as an
SVG picture of the drawing, with its entity counts and layers listed under it.
Source is one tap away.

- `src/web/render/dxf.ts` parses and draws; `kinds.ts` maps `.dxf` to the `dxf`
  kind; `renderers.ts` names the renderer.
- Drawn: LINE, CIRCLE, ARC and LWPOLYLINE, in one colour, y up, fitted to the
  drawing's bounds. Polyline bulges are drawn straight.
- Not drawn, only counted: every other entity (TEXT, DIMENSION, INSERT, ...).
- At most 50,000 shapes are drawn; the page says how many drawable ones were
  left out. Layer names and entity types are escaped.
- No ENTITIES section, no EOF, no drawable entity, or a file past the size
  cap: the source view, with the reason.
- Try it: commit a `.dxf` to a repository and open its file page.
