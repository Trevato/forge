# Search box

## At 390 px (#9351)

What a search finds is other people's words, so inside `[data-search]` (an attribute, not a class; rules in
`SEARCH_CSS`, `src/web/pages/search.ts`) a result row's title and meta wrap and break long words anywhere in place of
the one-line ellipsis. A matching line of code keeps `white-space: pre` and scrolls inside its own box
(`overflow-x: auto`). The query box may shrink. No fixed width; the page does not scroll sideways. No new class.
The owner's phone look of `/search?q=sample` is attached to the pull.
