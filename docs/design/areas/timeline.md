# Timeline

The event timeline on an issue or pull thread: a vertical rail of `.tl-item` rows, each with a dot, comments as cards and events as one dim line.

- `.timeline` — the column that holds the rows and draws the rail behind their dots. Written by `conversation()` in `src/web/pages/thread.ts`, `timelineOf()` in `src/web/pages/browse.ts` and `appEgressView()` in `src/web/pages/settings.ts`; styled in `src/web/style/components.ts`.
- `.tl-dot` — the round glyph on the rail at the head of each row, tinted by the row's `data-tone`. Written by `tlEvent()` and `tlComment()` in `src/web/ui.ts` and `threadComment()` in `src/web/pages/thread.ts`; styled in `src/web/style/components.ts`.
