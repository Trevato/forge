# Front

The studio's front page (`studioDoor()` in `src/web/studio/home.ts`) shows an admin, under the shelf of public apps, the
controls that pick what the shelf shows; strangers never see them. The rules live in `src/web/style/content.ts`.

- `.front-admin` — the admin's controls under the front page (`studioDoor()` draws it around `frontControls()`), as wide as the shelf above it and centred with it.
- `.front-pick` — one row of choices in those controls (drawn by `frontControls()`): the entry's name, then its pin, unpin, hide or show buttons at the end, its inline forms without the end margin `form.inline` would give them.
