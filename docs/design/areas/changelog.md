# Changelog

## The page at 390 px (#9349)

`/changelog` is day `card()`s whose `<ul>` carries `list setting-list`, the shared rule in `style/components.ts` that
wraps a row, lets its title and meta break long words anywhere, and drops the trail onto its own line under 640px.
No page-local style, no fixed width; the page does not scroll sideways. No new class.

The preview seed merges one pull with a long title and an unbroken 120-character word (`PREVIEW_LANDING_TITLE`) into
the sample before its forks are made, so the preview's `/changelog` phone look shows a real row, not the empty state.
