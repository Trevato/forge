# Next up

- `.next-week`: a row dimmed (opacity only, no layout change) while it is dragged below the cut line, so it reads as next week. Added and removed by the page's script during a drag; absent at rest.
- Dragging is mouse-only (HTML5 drag does not fire on touch); on a phone a row moves by its Top/Up/Down buttons. A pointer path is a later change.
- Fit at 390 px (#9324): no new class. `[data-next]` (an attribute on the page's wrapper) breaks long words anywhere; a row asks for 14rem so its Top/Up/Down/Not now buttons wrap under the text instead of squeezing the title, and the buttons wrap in `.row-after`.

## Rows under headings, not boxes (#9764)

The head is `pageHead("Next up")` with one sentence: the crew builds strictly from the top. The ranked list is a `<ul class="list setting-list">` straight under `<h2>Ready, in order</h2>`, and Not now (`?all=1`) the same under its own `<h2>`: no card, not even a bare one, since a list is rows (principle 7). Inside `[data-next]` the rows are spaced by a 4px gap, not ruled by hairlines (principle 3); the cut line keeps its dashed rule, as it marks where this week ends. The week's projection, its link, and for a writer the drag and j/k hint sit in one muted line after the list, beside the buttons that show their own keys. Blocker or Enabler is muted text in the row's meta (no badge). Top/Up/Down/Not now stay plain same-origin POST forms; each row still names its issue number, who is on it and what it waits on. No new class.
