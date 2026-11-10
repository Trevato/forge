# /docs

`GET /docs` is a server-rendered index of `docs/*.md` in the release's checkout: each file's title (its first `#` line) and a link. `GET /docs/NAME.md` renders that file with the forge's markdown renderer inside the layout. NAME must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.md$` and be in the folder's listing; anything else, `..` included, is a 404. Links between docs (`OTHER.md`) resolve to `/docs/OTHER.md`.

The listing and each rendered page are kept in memory for the life of the process, since docs change only with the release. The folder is never read from FORGE_APP_DATA. Only files directly in `docs/` are served; subfolders (`design/`, `features/`) are not, and a link to a name outside the listing is left as written. The terminal has the same list: the `Docs` command (`src/tui/screens/docs.ts`); both read `src/view/docs.ts`. Footer and the `?` sheet link "Docs". Code: `src/web/pages/docs_link.ts`.
