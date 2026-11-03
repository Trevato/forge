# A preview of the forge, looked at as its owner

Looks of a public app on a public repository are taken signed out, and most
of the forge's own pages are an admin's: a preview's pictures of home, /flow
and /talk came out blank. Two halves fix that (#8812).

**The parent picks the pages.** `app.looksAsOwner` in `forge.json` names
pages of `app.looks` whose phone and desktop pictures are taken signed in
as the repository's owner, an admin, through the grant door
(`src/looks/service.ts`). Every other page is still taken as nobody, and
every thumb too. Pictures taken as the owner are the writers' alone
(`mayFetchLook`), so a reader of the pull does not see them. A page named
there that `app.looks` does not name is a manifest error. The forge names
`/`, `/flow` and `/talk`.

**Four looks every forge preview takes.** Whatever `forge.json` lists, a
preview of the forge's own repository (`FORGE_REPO`) is pictured as its
owner at desk and phone width on home with its pins, /flow,
`/preview-admin/sample` and the seeded pull's page: the named list
`PREVIEW_OWNER_LOOKS` in `src/spawn/preview-looks.ts`, which the looks
service adds to the manifest's pages (#8974). Production, and every other
app, take only what their manifest lists.

**The preview has an owner to be.** When the platform says
`FORGE_APP_ENV=preview`, the forge seeds a site admin, `preview-admin`, and
a small world for it once (`src/spawn/preview-seed.ts`): a public repository
`preview-admin/sample` with two issues and an open pull, three agent runs
that spent this week and a valve turned to 60% (the flow week), and two
board panels pinned to home. In a preview, a request whose
`x-forge-identity` is signed under `FORGE_APP_IDENTITY_KEY` and names an
admin is that admin (`src/spawn/preview-owner.ts`) — the parent's looks, and
any writer who opens the preview from the forge. It counts as an edge
identity, so mutations are held to the same-origin rule.

**Production refuses both.** Anywhere `FORGE_APP_ENV` is not `preview`, the
seed answers `not_preview` and makes no one, and the key is never read, so
the identity headers are ignored. The admin has no password and no session:
nothing to show, nothing to log. `test/looks-owner.test.ts` proves each
of these.
