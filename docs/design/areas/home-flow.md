# The pipeline home

`/home` (`src/web/pages/home_flow.ts`, styled by `src/web/pages/home_flow_style.ts`) answers "what is my forge doing right now" on one screen: six lanes of tiles, a strip of figures above them, one line of hosted forges below. Every colour is a token, every size is on the type scale, every space on the spacing scale; the lanes are the one layout no other component draws, the tiles are small cards.

- `.hf` — the page column: head, strip, lanes, forges line, in that order, 16px apart.
- `.hf-head`, `.hf-title`, `.hf-live` — the title, and beside it the stream's state ("Live: updates as it happens", or that it is reconnecting).
- `.hf-filter`, `.hf-filter-label` — the quiet filter to one app: a plain GET form, a select that submits itself and a Show button only when scripts are off.
- `.hf-strip` — the one live region over the figures. It holds either the calm line `.hf-calm` ("Nothing needs you right now.") or, only for a real need (a red main, a stopped forge or landing line, a failed proof), the one line `.hf-need` with `.hf-need-more`.
- `.hf-figs`, `.hf-fig`, `.hf-fig-label`, `.hf-fig-value`, `.hf-fig-note`, `.hf-fig-spark` — a figure: its name, its value with the unit in the value or the note, and a tiny trend where the data has one. Two across on a phone, five across from 720px.
- `.hf-lanes` — one lane under the other on a phone, three by two on a tablet, six across on a desk.
- `.lane` — one lane, a live region of its own (`data-live`, `data-live-src="/live/lane?s=<lane>"`) so one event redraws one lane. Its `data-tone` (quiet, flowing, waiting, stuck) draws the top edge; `data-count` is the number in the head.
- `.lane-head`, `.lane-name`, `.lane-name-link`, `.lane-count` — the lane's name (a link to the full list it counts) and its count.
- `.lane-health`, `.lane-state` — the lane's own health, a dot and a word, then a full sentence saying what it waits on and how old its oldest item is.
- `.lane-list` — the lane's tiles, in the order the next worker takes them.
- `.lane-more`, `.lane-more-lg`, `.lane-more-md`, `.lane-more-sm` — "N more" under the tiles; one of the three shows, by how many tiles the screen draws.
- `.tile`, `.tile-link`, `.tile-top`, `.tile-app`, `.tile-no`, `.tile-clock`, `.tile-title`, `.tile-hint`, `.tile-who`, `.tile-more` — one change: the app and number, how long it has been in this lane, its title in plain words, who has it and one sentence of where it is. `data-key` is stable across lanes, so the page glides a tile from the lane it left to the lane it reached (`home_flow_client.ts`); `data-state` is `waiting`, `active` (a pulse on the clock) or `done` (live).
- `.hf-forges` — the hosted forges in one line: how many, how many awake, any that is awake but silent.
- `.hf-foot` — the way back to the classic home, and the feed.

Motion is two things only, an arrival wash on a new tile and the pulse on work in progress; both stop under `prefers-reduced-motion`, and the glide is not drawn at all. A phone shows each lane as a glance: its first tile and the count of the rest.
