# Explore

`/explore` (`src/web/studio/explore.ts`). Paging is one `btn` (outline, "More results") in `.explore-more`, which makes it full width and 44px tall so it is a thumb-sized target on a 360px phone. It is an ordinary link, so it works without a script.

The count line above the list (`[data-hits]`, a muted span at the end of the sort bar) is server-rendered with a 24px line height, so the list never moves; "Clear filters" appears in it only while a filter (not the sort) is active.

The how-to is in docs/features/explore.md.
