# Search box

## At 390 px (#9351)

What a search finds is other people's words, so inside `[data-search]` (an attribute, not a class; rules in
`SEARCH_CSS`, `src/web/pages/search.ts`) a result row's title and meta wrap and break long words anywhere in place of
the one-line ellipsis. A matching line of code keeps `white-space: pre` and scrolls inside its own box
(`overflow-x: auto`). The query box may shrink. No fixed width; the page does not scroll sideways. No new class.
The owner's phone look of `/search?q=sample` is attached to the pull.

## Rows under a heading (#9689)

Each section of the results (apps and repositories, issues and pull requests, code) is a heading over a `.list` of `.row`s in a `.card.bare` (#9588): rows on the page's one background, no box. No new class; `test/studio-search.test.ts` holds it.
