# Home

- `.moving` — the living home's two lists (Being built, Just shipped), drawn by `movingRegion` in `src/web/studio/living.ts`: a one-column grid on a phone, two equal columns from 700px. Each list always holds three rows, so a quiet list is as tall as a busy one and nothing below it moves.
- `.tell-box` — home's one-line box that tells the crew: a `bar` whose text input takes the free width (`flex: 1 1 14rem`) and wraps the app picker and Tell under it on a phone.
- `.kpi-row` — a modifier on `.stats` for the home's figure tiles, not a second layout: it only changes the phone case. `.stats` alone (`minmax(160px, 1fr)`) falls to one column at 360px (two 160px tiles and the gap need 332px of 328px), stacking nine 104px tiles to ~1,100px; under 480px `.kpi-row` is two equal `minmax(0, 1fr)` columns instead. Tile height stays fixed (`.stat`), so nothing shifts.
- `.home-panels-slot` — home's place for the pinned panels, right after the KPIs (`pinnedSlot` in `src/web/studio/pinned.ts`). Only while it still waits for `/live/home/panels` (`data-refresh`) it holds 240px, about one panel row, with the 16px below it that `.bgrid` keeps (the system has no spacing tokens, only the 4px scale in §4, and both sit on it), so the charts arriving after first paint shift nothing; the refresh script drops the attribute when the fragment lands, is empty, or fails, and the slot collapses to its content.

The signed-in home's door line (Notes, Talk) is `.home-doors`: accent underlined links, each a 44px tap target (#9584).
