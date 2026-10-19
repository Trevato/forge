# What /map shows (#2768)

Part of #2695. A reading of `src/web/pages/map.ts`, section by section: does a
board or an issue's dependency list already show it, and keep or cut. This
document changes no code; each **cut** is a follow-up issue, not done here.

An issue's dependency list shows one issue's direct edges. A board shows
work by state, per app, with a "merged by pillar" line. Neither draws the
whole graph or follows a chain more than one hop.

## Per-app map (`/:owner/:name/map`)

- `Map canvas` — every open issue laid out by what it waits for (`drawMap`, id `map-canvas`). Neither board nor dependency list draws the transitive graph. **Keep**: it is the page.
- `Counts line` — the words (ready, waiting, working…) counted under the canvas (`countsLine`). Boards count by state, not by wait. **Keep**, it is one line.
- `Autonomy line` — spend and autonomy under the heading (`autonomyLine`). Spend already has its own page and the board header. **Cut**.
- `By pillar` — each pillar's issues by word, with the ask to live (`pillarList`). Boards show only what merged per pillar in 7 days; milestones show how far each umbrella is. Open work per pillar is shown nowhere else. **Keep**.
- `Ready now` — open issues nothing stands in front of, with how many each frees (`rankedList`). The dependency list shows one issue's blockers, not the ready set; the board's queue is by claim, not by wait. **Keep**.
- `Blocked on` — issues that hold others up, most first. Only the map ranks by what a blocker holds up. **Keep**.
- `Critical path` — the longest chain still to do, shown again as a list and as the accent on the canvas. The canvas already draws it. **Cut** the list, keep the accent.
- `Two weeks` — open issues as a line over closed per day as bars (`chart`). Boards show flow as panels and `/flow` shows the same level and rate; nothing about it is about waiting. **Cut** (it belongs with `/flow`, folded into boards by #2693).

## Global map (`/map`)

- `Lanes` — one lane per app you can see, each a small map (`laneHtml`). A board lists work by state across apps, not by wait. **Keep**.
- `Spend bar` — each lane's autonomy spend (`spendBar`). Shown on spend and usage. **Cut**.

## Cutting

Cutting `Autonomy line`, `Critical path` list, `Two weeks` and `Spend bar`
leaves the canvas, counts, pillars, ready and blocked: what only the graph
can say.
