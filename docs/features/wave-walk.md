# Walking a wave

A wave names the pulls it carries. You can go from the wave to a pull, to its conversation, and back, on the page and in the terminal.

## On the page

1. Open `/<owner>/<repo>/waves` and pick a wave, or go to `/<owner>/<repo>/waves/<version>`.
2. Tap a pull in its list. The link carries `?from=<owner>/<repo>@<version>`, so the pull page knows where you came from.
3. The pull page opens on its verdict and the conversation. Above the verdict a breadcrumb reads `Wave <version> / This pull`.
4. Tap `Wave <version>` to return to the wave.

The `from` value is checked against the shape of a wave address before it is used; anything else shows no breadcrumb.

## How far the wave got

When a wave's pulls closed issues under a milestone, the wave opens as its headline, then one progress line (`<milestone>: 1 of 2 done`, the widest milestone it moved), then the highlights. Under **Moved** each change is a closed fold: tap it to see the pulls of this wave that moved it, and a link to the milestone. Pulls no fold holds (another repository's, or ones that closed no milestone issue) are listed under **Pulls**; each pull is said once. A wave that moved no milestone has no progress line. The MCP `waves` tool says the same line as `progress`, and the terminal prints it under the date, with each moved milestone's pulls beneath it. Tested in `test/wave-folds.test.ts` and `test/tui-waves.test.ts`.

## In the terminal

1. Open a repository's Waves screen and press Enter on a wave.
2. `n` (or Tab) and `p` move the `>` mark among the wave's pulls; Enter opens the marked pull.
3. Esc (or `q`) on the pull returns to the wave, and again to the list.

Only pulls the viewer may read are listed, and Enter re-checks that before opening one. The walk is tested in `test/story-walk.test.ts` and `test/tui-waves.test.ts`.

## A wave's size

Each wave says how big it is in plain numbers, such as `7 changes in 3 apps`: on the list row, under the headline on the wave's page, on the terminal's waves list and at the top of a wave there, and as `pulls` and `apps` on each item of `GET /api/v1/repos/<owner>/<repo>/waves`. The numbers count only the pulls you can read, once each, so a guest is not told how many private pulls a wave holds.
