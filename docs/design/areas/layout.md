# Layout utilities

The spacing and layout utilities every page leans on: one component, styled in `style/base.ts`'s `utilities` layer, so a page spaces and sizes its blocks without a class of its own.

- `.mt` — a 12px top margin between a block and the one above it; `pages/commits.ts` (`<div class="mt">`), `pages/issues.ts` and most pages write it. Styled in `style/base.ts`.
- `.mb` — a 12px bottom margin, the same step downward; `pages/commits.ts` (`<div class="bar mt mb">`) and `pages/settings.ts` write it. Styled in `style/base.ts`.
- `.stack` — a flex column with a 12px gap, for a run of cards or form rows; `pages/looks.ts`, `pages/returns.ts` and `pages/everyday.ts` write it. Styled in `style/base.ts`; `style/components.ts` drops the card-to-card margin inside it and `style/content.ts` adjusts it under `#needs-you`.
- `.stack-tight` — beside `.stack`, narrows its gap to 4px; `pages/looks.ts` and `pages/first-admin.ts` write it. Styled in `style/base.ts`.
- `.spacer` — an empty flex child that takes the free space and pushes what follows to the end of a row; `pages/commits.ts` and `pages/edit.ts` write it. Styled in `style/base.ts` (also inside `.topbar`), `style/components.ts` (`.pager`) and `style/content.ts` (`.app-strip`, `.comment-form`).
- `.grow` — a flex child that takes the free space and may shrink below its content (`min-width: 0`), so its text can truncate; `pages/edit.ts`, `pages/settings.ts` and `pages/board.ts` write it. Styled in `style/base.ts`; `style/components.ts` ellipsizes it inside `.menu-item` and `.palette-item`.
- `.narrow` — a 400px column centred a little below the top, for a single short form or notice; `pages/oauth.ts` writes it. Styled in `style/base.ts`.
- `.narrow-wide` — a 760px reading column for a page of one form or one text; `pages/edit.ts`, `pages/issues.ts` and `pages/forges.ts` write it. Styled in `style/base.ts`.
- `.page-head-sub` — the one line under a page head's title: `flex-basis: 100%` and a −4px top margin, so it breaks onto its own full-width line. A layout hook, not a look: it rides with `muted small` (or `bar muted small` for a row of facts); `pageHead({ sub })` in `chrome.ts` and the run, tell, change and browse heads write it. Styled in `style/components.ts`; a `.muted.small` child of a page head without it (the system page's Processes sort row) stays beside its heading.

- `[data-region]` — a late region of home (`#home-<name>`, `src/web/studio/home_last.ts`): `display: contents`, so the wrapper that lets the page swap it adds no box of its own and the layout is what it was without it.
