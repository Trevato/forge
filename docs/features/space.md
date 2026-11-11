# The space

`/:owner/:name/space` is the map as a plane you move through (#10444). It is
linked from the map page ("The same work as a space to move through"). Its data
is `/:owner/:name/space.json`, the same plane for an agent. In the terminal it is the `space` entry in the palette (`src/tui/screens/space.ts`): pillars with their counts, issues by state, who of the crew is on what, and the week's landings, from the same `spaceOf` and so the same gate as the page (a guest sees what is public, an admin everything).

## Use

- **Move.** Drag (or two fingers) to pan; pinch, wheel or `+`/`-` (also with ⌘/Ctrl) to zoom; arrows pan; `0` or **Fit** shows the whole plane; `n` or **Now** returns to live. No page scroll fights it (`touch-action: none`).
- **Semantic zoom.** Out: pillars are regions whose area follows open work, with a progress bar (landed ÷ open + landed over the week) and whether they moved. In: each region's issues sit in clusters by state (ready, building, in review, waiting, landed). Further in: an issue is a card with its title, then its pull, checks and the crew member on it. Words are set at a fixed pixel size at every level; detail is added, nothing shrinks.
- **Time.** The scrubber replays the last 7 days: issues appear when opened, slide from "in review" to "landed" when they close, and crew members sit on what they were running then. **Play** runs the week in 20 seconds. At **Now** the view is live: any run, issue or pull event of the repository fetches the plane again.
- **Crew.** Their avatars sit on the issue they are working; tap one (or its name in the bar) to see what they are on.
- **Share.** The view is in the address hash: `#x=…&y=…&z=…` (centre in world units, zoom relative to Fit) and `&t=` (minutes since the epoch) when scrubbed back.

## How it is built

- `src/web/space_model.ts` — pure placement: treemap of regions, grid of cells per cluster. Plain data in, compact arrays out.
- `src/web/space_read.ts` — reads what the map page reads (graph, words, pillars, runs) and keeps the answer by the write clock (`map_snapshot.ts`).
- `src/web/space_view.ts` — the client's arithmetic (placement over time, crew at a time, address hash, tap picking) as plain functions; the page ships their source, the tests call them.
- `src/web/space_client.ts` — one 2D canvas, drawn only when the view changed; culls to the viewport.
- `src/web/pages/space.ts` — the page (server-rendered pillar list under the canvas for no-JS readers) and the JSON.

`space.json` carries an ETag (the body's hash): a refetch after an event whose change the plane does not draw is answered 304, and the body is encoded by the server (`http/compress.ts`) otherwise. About 1.5 MB at forge scale before encoding.

Without script the page is the pillar list alone: the canvas, bars and scrubber show only once the script sets `space-on`. If the first load fails the list stays and says so. State is told by a cluster's label and position and by weight (muted as work ages), not by hue; the accent is for the crew and the controls.

Assumptions shown: the week's landed work is the closed issues the map's graph still carries (those on an edge); issues closed more than 7 days ago are not drawn. Before an issue landed, it is drawn in review, its slot there reserved by the layout (history of earlier states is not stored).

Test: `test/space-model.test.ts` places 12,000 issues and checks the size of the JSON (under 3 MB; the time is logged, not asserted); `test/space-view.test.ts` tests the client's placement, crew, hash and tap functions, which the page ships from `src/web/space_view.ts`; the canvas's own paint is measured by hand on a device, not in a test.
