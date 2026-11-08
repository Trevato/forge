# Plan map

The map of what waits for what (`/:owner/:name/map`): one SVG of the repository's open issues as cards, laid out by
dependency, with the edges between them and the pillars beside it. `mapPage` in `src/web/pages/map.ts` draws the page and `drawMap`
the SVG; `mapCss` there holds every rule below. A card's state (ready, working, blocked, waiting, parked, held, deferred, done)
is `data-state` on `.map-node`, not a class.

- `.map-wrap` — the page's two-column grid: the canvas, then the 272px side column; one column under 860px.
- `.map-main` — the canvas column; `min-width: 0` so a wide map never pushes the side column off the page.
- `.map-canvas` — the bordered frame the SVG sits in; `is-view`, `is-drag` and `is-cut` say whether it pans, is being dragged, or is cut off with a fade.
- `.map-svg` — the map's SVG itself, full width; its text uses the page font and never takes the pointer.
- `.map-rule` — the labelled line across the map above the issues that are "not linked" to any other.
- `.map-node` — one issue's card, a link to the issue; `data-state` sets its colours.
- `.map-card` — the card's rectangle, filled and stroked by the node's state.
- `.map-breath` — the soft accent ring around a card being worked on.
- `.map-title` — the issue's title on the card.
- `.map-meta` — the issue's number, in tabular figures.
- `.map-who` — the assignee's mark: a circle with an initial and a name.
- `.map-who-i` — the assignee's initial inside the circle.
- `.map-who-n` — the assignee's name beside it.
- `.map-word` — the state's word at the card's right edge.
- `.map-dot` — the coloured dot before the state's word.
- `.map-edge` — one dependency edge between two cards.
- `.map-edge-crit` — an edge on the critical path, in the accent.
- `.map-edge-done` — an edge with a closed issue at either end, faded.
- `.map-toggle` — the link beside the counts that swaps between "Show done" (`?done=1`) and "Open only"; padded, 44px tall under `pointer: coarse`. It is a link, not a badge.
- `.map-ask` — a pillar row's lead-time figures in the side column, inline, with the hover title saying what they measure.

The Ready now list's **First** button (a writer's `method="post"` form in the row's trail) and its "first, by <who>" meta line add no class: they are `row`'s `trail` and `meta` and the outline `btn`. The list is `.setting-list`, so the meta wraps and under 640px the trail drops to its own line.

## Rows and space, not boxes (#9760)

The side column is two headed lists, Ready now first, then By pillar and Blocked on: each a bare `ul.list.setting-list` under its heading (no card box), one row an
issue on the page's one background, no frame and no badge. A row says its word (ready, blocked, waiting, held, parked), what
stands in front of it (`waits for N`) and what it holds up; a pillar row says its counts as muted text. `.map-canvas` has
no border: the drawing sits on the page. The First button, its same-origin POST form and the 390px single column are
unchanged. No new class.
