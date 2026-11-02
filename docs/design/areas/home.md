# Home

- `.moving` — the living home's two lists (Being built, Just shipped), drawn by `movingRegion` in `src/web/studio/living.ts`: a one-column grid on a phone, two equal columns from 700px. Each list always holds three rows, so a quiet list is as tall as a busy one and nothing below it moves.
- `.tell-box` — home's one-line box that tells the crew: a `bar` whose text input takes the free width (`flex: 1 1 14rem`) and wraps the app picker and Tell under it on a phone.
- `.kpi-row` — a modifier on `.stats` for the home's figure tiles, not a second layout: it only changes the phone case. `.stats` alone (`minmax(160px, 1fr)`) falls to one column at 360px (two 160px tiles and the gap need 332px of 328px), stacking nine 104px tiles to ~1,100px; under 480px `.kpi-row` is two equal `minmax(0, 1fr)` columns instead. Tile height stays fixed (`.stat`), so nothing shifts.
