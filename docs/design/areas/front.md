# Front

The studio's front page (`studioDoor()` in `src/web/studio/home.ts`) shows an admin, under the shelf of public apps, the
controls that pick what the shelf shows; strangers never see them. The rules live in `src/web/style/content.ts`.

- `.front-admin` — the admin's controls under the front page (`studioDoor()` draws it around `frontControls()`), as wide as the shelf above it and centred with it.
- `.front-pick` — one row of choices in those controls (drawn by `frontControls()`): the entry's name, then its pin, unpin, hide or show buttons at the end, its inline forms without the end margin `form.inline` would give them.

The page a visitor reads first runs past §3's working scale on purpose, in `clamp()` sizes: it is read once, from a distance, and every other screen is worked in. Its colours are tokens, its section rules are hairlines, and `.card` and `.look` stay §5's, with the card's frame taken off inside the shelf. `studioDoor()` draws all of these.

- `.door` — the page's frame, with its section rhythm and heading sizes.
- `.door-hero` — the first screen: `.door-lead`, and `.door-live` beside it when there is something live to show.
- `.door-lead` — the hero's sentence, support line and actions.
- `.door-support` — a section's line of plain support, at 16px.
- `.door-live` — the hero's panel of real activity on public repositories: figures, the crew at work, what just merged. Absent with nothing to say.
- `.door-figures` — the panel's row of figures, each a `.door-figure`.
- `.door-figure` — one real count and its label; a zero count is left out.
- `.door-now` — a label inside the panel, with the crew's dot when it is at work.
- `.door-ledger` — a list of one-line links inside the panel.
- `.door-when` — where a merged change was made and how long ago.
- `.door-section` — one section after the hero, with room above it and an offset for anchors.
- `.door-shelf` — the apps: two columns on a phone, four from 720px, each a §5 card with its frame taken off.
- `.door-open` — a tile's one line that opens the app.
- `.door-more` — the link to the rest of the apps.
- `.door-steps` — how it works: three numbered steps, in columns from 720px.
- `.door-split` — a section as a heading column beside a content column, from 720px.
- `.door-points` — the content column's definition list, ruled by hairlines.
- `.door-code` — the commands that run a forge.
- `.door-wide` — a visitor's top-bar link that a phone leaves out, so the bar never overflows.
