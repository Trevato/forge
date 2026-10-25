# Page shell

The chrome every page sits in: the sticky top bar, the main column and the footer, drawn by `page()` in `src/web/layout.ts` (the top bar by `topbar()`, its search by `searchBar()`). Rules live in `src/web/style/base.ts`, the search field's in `src/web/style/components.ts`.

- `.topbar-tools` — the top bar's right-hand group (search, Asks, the new and user menus): one row that may shrink but never wraps, its bare `a.small` links 44px tall.
- `.topbar-search` — the top bar's search form: an icon, a borderless input and its `/` key hint in one bordered pill, the border taking the accent on focus. Shown from 720px; below that the icon button carries search.
- `.hide-lg` — shown under 720px, hidden from 720px: the narrow-screen stand-in for something `.hide-sm` shows on wide screens (the search icon button beside `.topbar-search`).
- `.shell-wide` — on `<main class="shell">` when a page passes `wide`: from 1200px the column drops its reading width and keeps a 24px gutter, for the one layout that gains from every pixel (a tree beside a file).
