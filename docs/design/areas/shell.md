# Page shell

The chrome every page sits in: a skip link, the sticky top bar with the wordmark, the main column and the footer, drawn by `page()` in `src/web/layout.ts` (the top bar by `topbar()`, its search by `searchBar()`, the footer by `footer()`); a page hands over its body and never draws the frame itself. Rules live in `src/web/style/base.ts`, the search field's and the crumbs' narrow-screen rule in `src/web/style/components.ts`.

- `.skip` — the "Skip to content" link, first in the document and hidden above the top until it has keyboard focus.
- `.topbar` — the `<header role="banner">` across the top of every page: wordmark, crumbs, then the tools.
- `.wordmark` — the forge's name and mark, linking home (`g h`); the mark turns on hover. Also written by the board's own header in `src/web/pages/board.ts`.
- `.topbar-tools` — the top bar's right-hand group (search, Asks, the new and user menus): one row that may shrink but never wraps, its bare `a.small` links 44px tall.
- `.topbar-search` — the top bar's search form: an icon, a borderless input and its `/` key hint in one bordered pill, the border taking the accent on focus. Shown from 720px; below that the icon button carries search.
- `.hide-lg` — shown under 720px, hidden from 720px: the narrow-screen stand-in for something `.hide-sm` shows on wide screens (the search icon button beside `.topbar-search`).
- `.shell` — the `<main id="main">` column: the page's width, centred, with its side and bottom padding.
- `.shell-wide` — on `<main class="shell">` when a page passes `wide`: from 1200px the column drops its reading width and keeps a 24px gutter, for the one layout that gains from every pixel (a tree beside a file).
- `.bare` — the `<main>` of a page that owns the whole window: no top bar, no footer, no width or padding. Written when the page passes `bare: true` (the board, `src/web/pages/board.ts`).
- `.foot` — the `<footer>` under every non-bare page: the mark, the links, the reduced-motion note.
- `.bar` — a wrapping row of controls with an 8px gap, used across pages for a header's actions, a filter bar or a line of meta (for instance `src/web/pages/commits.ts`, `src/web/pages/repo.ts`, the board's header in `src/web/pages/board.ts`). A `.field` directly inside drops its bottom margin and the row aligns to the end, so a labelled input and its button share a baseline. `.seg` and `.device-code` inside it are styled in `src/web/style/content.ts`.
