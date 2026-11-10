# Walking a wave

A wave names the pulls it carries. You can go from the wave to a pull, to its conversation, and back, on the page and in the terminal.

## On the page

1. Open `/<owner>/<repo>/waves` and pick a wave, or go to `/<owner>/<repo>/waves/<version>`.
2. Tap a pull in its list. The link carries `?from=<owner>/<repo>@<version>`, so the pull page knows where you came from.
3. The pull page opens on its verdict and the conversation. Above the verdict a breadcrumb reads `Wave <version> / This pull`.
4. Tap `Wave <version>` to return to the wave.

The `from` value is checked against the shape of a wave address before it is used; anything else shows no breadcrumb.

## In the terminal

1. Open a repository's Waves screen and press Enter on a wave.
2. `n` (or Tab) and `p` move the `>` mark among the wave's pulls; Enter opens the marked pull.
3. Esc (or `q`) on the pull returns to the wave, and again to the list.

Only pulls the viewer may read are listed, and Enter re-checks that before opening one. The walk is tested in `test/story-walk.test.ts` and `test/tui-waves.test.ts`.
