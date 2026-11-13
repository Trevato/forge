# Changelog

## The page at 390 px (#9349)

`/changelog` is day `card()`s whose `<ul>` carries `list setting-list`, the shared rule in `style/components.ts` that
wraps a row, lets its title and meta break long words anywhere, and drops the trail onto its own line under 640px.
No page-local style, no fixed width; the page does not scroll sideways. No new class.

The preview seed merges one pull with a long title and an unbroken 120-character word (`PREVIEW_LANDING_TITLE`) into
the sample before its forks are made, so the preview's `/changelog` phone look shows a real row, not the empty state.

## Rows, not boxes (#9688)

Each day is a `<section data-day>` with an `<h2>` (the day, the UTC mark when the zone is not the reader's, the count) over a `list setting-list`; "On its way" is an `<h2>` over the same list. The empty state is one muted line, `<p class="mt muted">Nothing has shipped yet.</p>`, the same quiet line the board's Landed region uses (`region()` in `pages/board.ts`); not `empty()`, which is a card. No card, no new class; `test/changelog.test.ts` holds it, and `localDaysJs` still finds `[data-day]`, `h2 time`, `[data-zone]` and `.badge`.

## Releases as rows (#9753)

`/releases` is one `list setting-list` of `row()`s, no table, no card. The title is the short sha with its `live` and `preflight failed` badges; the meta line is the pull (`#7`), when it landed and, for the live one, since when it has been healthy. A release with a pull is one `<a>` to that pull; the Roll back form sits in the row's `after` slot, outside the link, so it posts with JavaScript off. The empty state is one muted line. No new class; `test/releases-page.test.ts` holds the shape.

## Chapters on the changelog (#11868)

A closed chapter is one `row()` in a `list setting-list` (its name as the title, the closing note's first sentence in plain words as the meta, `Means` and `Pulls` as the row's `facts` dl, the close date as the trail), followed by the pulls under the same day headings as everywhere else. The closing note is never shown as raw markdown: `noteWords` drops the headings and marks and keeps one sentence. No new class; `test/changelog-chapters.test.ts` holds it.
