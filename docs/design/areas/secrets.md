# Secrets (Settings › Secrets, an organization's page, a repository's settings)

`secretsCard()` in `src/web/pages/secrets.ts` adds no component class. It draws one block in three places: the forge's
`/settings/secrets`, an organization's page and a repository's settings. As on the home page, it is a heading over rows:
a `<section class="settings-block">` with an `<h2>`, one muted sentence (sealed values handed to a run by name; the narrowest place wins), a `.setting-list` of `row()`s (name, when it
was set, when it was last opened, Remove), and the set form as an `.edit-row`. No card around it, and no icon in a
row's lead. Values are write-only: the value field is a password input that is never filled. `test/secrets-card.test.ts`
renders all three places and finds the same class names. Classes used are named in `docs/design/areas/settings.md`.
