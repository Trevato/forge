# Feed

- `.feed-head` — the head of the home's feed: a §5 `.bar` above the timeline holding the "What you asked for" link, pushed to the end by a spacer. Drawn by `studioHome` in `src/web/studio/home.ts`, styled in `src/web/studio/feed_style.ts`. Under 900px it is hidden, since that link is a tab on a phone and the first post should come next; a bare `.bar` cannot carry this, as it has no reason to vanish on a narrow screen.
- `.feed` — the home's timeline list: a one-column grid with no gap that holds the feed's cards, each focusable with a visible outline and removed from layout while `hidden`. Drawn by `drawRegion` in `src/web/studio/feed.ts` (the `#live-feed` section), styled in `src/web/studio/feed_style.ts`.
