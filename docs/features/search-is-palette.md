# Phone search is the palette

The bare `/search` page (no query) marks itself `data-palette-auto`. On a script-enabled browser narrower than 720px (`opensAsSheet`, `src/web/palette.ts`) the shell opens the command palette's bottom sheet on load: the same dialog, the same page index, the same `rankPalette`. Wider, unmarked, or without script, nothing opens and the server-rendered search form is the page.

Focus lands in the palette input. Escape (or a tap outside) closes it and focus returns to what had it, the form's autofocused search box. The sheet stays open if the window crosses 720px; `.palette` simply restyles as the centred dialog. A results page (`/search?q=…`) never auto-opens, since the palette's "more results" link leads there.

Shortcuts are unchanged: Cmd/Ctrl K opens the palette anywhere; `/` focuses a page's search box. The terminal's palette (`src/tui/`) keeps its own ranking and is not part of this.

Tests: `test/search-is-palette.test.ts`.
