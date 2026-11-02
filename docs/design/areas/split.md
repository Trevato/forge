# Split

A page that sets its main column beside a rail, and the glyph that separates parts of one line.

- `.split` — the one two-column page: main, then an `<aside>` rail of 260px that sticks from 960px. `data-rail="wide"` on it (the studio's home and an app's page) widens the rail to 320px from 900px, drops the top margin, and lets the rail scroll with the page, since a column of cards runs taller than a screen. Written by `pages/browse.ts`, `pages/repo.ts`, `pages/pull.ts`, `studio/home.ts`, `studio/app.ts`, `studio/tell.ts` and `studio/change.ts`; styled in `style/content.ts` (and `style/components.ts`, which closes the gap between stacked cards in it).
- `.sep` — a faint separator glyph between parts of one line: a `·` (aria-hidden) between meta items, a `/` between crumbs. Not a pane divider: `.split` has none. Written by `layout.ts` and `ui.ts` (crumbs), `scope.ts`, `pages/pull.ts`, `pages/origin-repos.ts`, `pages/site.ts` and `studio/change.ts`; styled in `style/components.ts`, with `.row-meta .sep` and `.crumbs .sep` spacing it in those contexts.
