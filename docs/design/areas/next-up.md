# Next up

- `.next-week`: a row dimmed (opacity only, no layout change) while it is dragged below the cut line, so it reads as next week. Added and removed by the page's script during a drag; absent at rest.
- Dragging is mouse-only (HTML5 drag does not fire on touch); on a phone a row moves by its Top/Up/Down buttons. A pointer path is a later change.
- Fit at 390 px (#9324): no new class. `[data-next]` (an attribute on the page's wrapper) breaks long words anywhere; a row asks for 14rem so its Top/Up/Down/Not now buttons wrap under the text instead of squeezing the title, and the buttons wrap in `.row-after`.
