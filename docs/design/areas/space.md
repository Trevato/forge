# Space

The repository space (`/:owner/:name/space`, `docs/features/space.md`): one full-screen canvas with a few controls over it. Buttons are the forge's `btn()`; the panel's facts are a `status-rows` `dl`.

- `.space` — the full-screen surface the canvas, bar, panel and time controls sit on.
- `.space-bar` — the row of buttons at the top; shown only when the script runs.
- `.space-time` — the scrubber along the bottom; shown only when the script runs.
- `.space-panel` — what a tapped issue or crew member is on: a heading and rows, on the page background with one hairline.
- `.space-list` — the pillar list the server draws; hidden when the script runs.
