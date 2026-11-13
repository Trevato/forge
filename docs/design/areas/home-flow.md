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
- `.tile`, `.tile-link`, `.tile-top`, `.tile-app`, `.tile-no`, `.tile-clock`, `.tile-title`, `.tile-hint`, `.tile-who` — one change: the app and number, how long it has been in this lane, its title in plain words, who has it and one sentence of where it is. `data-key` is stable across lanes, so the page glides a tile from the lane it left to the lane it reached (`home_flow_client.ts`); `data-state` is `waiting`, `active` (a pulse on the clock) or `done` (live).
- `.hf-forges` — the hosted forges in one line: how many, how many awake, any that is awake but silent.
- `.hf-foot` — the way back to the classic home, and the feed.

Motion is two things only, an arrival wash on a new tile and the pulse on work in progress; both stop under `prefers-reduced-motion`, and the glide is not drawn at all. A phone shows each lane as a glance: its first tile and the count of the rest.

## The table

`/home?view=table` (`web/pages/home_table.ts`, `flow/lanes_table.ts`) is the same items as one row each, from the same picture, so it costs no query of its own. It is §5's `.table` (`data-sortable`, `data-dense`) inside a `.table-scroll`; the rest is what sits around it. Search, lane, state, who, app and sort are links and a GET form, so a view is an address and works without script; the page's script adds instant search, picking rows and the action bar.

- `.hf-views` — the Lanes | Table switch: two links, the current one `aria-current="page"`; the choice is remembered in a cookie when the address asks for it.
- `.tb-search` — the search form: a search input and a Search button.
- `.tb-region` — the one live region of the table (`data-live-src="/live/table?…"`): chips, count, sort and rows swap together when work moves; an unchanged table answers 304.
- `.tb-chips`, `.tb-chipset`, `.tb-chiplabel`, `.tb-chip`, `.tb-chipn` — the filters as links, each saying how many rows it would leave and `aria-pressed` when chosen (choosing it again clears it); the same `.tb-chip` carries the sort links on a phone.
- `.tb-counts`, `.tb-sorts`, `.tb-empty` — how many rows are shown and the way to clear the filters; the sort by column as chips (the header links do the same on a desk); the empty sentence.
- `.tb`, `.tb-row`, `.tb-sel`, `.tb-app`, `.tb-no`, `.tb-what`, `.tb-lane`, `.tb-state`, `.tb-hint`, `.tb-who`, `.tb-time`, `.tb-age` — the table and its cells: the app and number, the title as a link, the lane, a dot and one sentence of where it is, who has it, time in the lane, and the age of the issue or pull itself. On a phone the header goes and each row is a small card: app and lane, title, sentence, who and time.
- `.tb-pick` — a row's check box, a 44px button with `role="checkbox"` and `aria-checked`, drawn only when script is on (it does nothing without it).
- `.tb-bar`, `.tb-barrow`, `.tb-picked`, `.tb-actions`, `.tb-note`, `.tb-confirm` — the action bar, shown while rows are picked, sticky under the top bar (not fixed over content): how many are picked, the actions that fit the kinds picked (close, move to Later, land, hand to the planner), then the preview in words with what would be refused and why, and Confirm or Cancel; after it, the receipt, which is where an undo lives.
