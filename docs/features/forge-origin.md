# A forge is an origin (#8900, first piece)

Connect another forge at `/settings/origins`: type its address and press "Sign in there". A token it gave you (Settings, Tokens there; `ro` is enough to bring code across) is the path for when sign-in is unavailable. `discover` asks `GET /api/v1/version`; a forge answers `{"version", "software":"forge"}` (a 0.5.x forge has no such route, and is known by `/api/v1/health` with its OAuth metadata), and is stored as an origin with `software = forge` (kind `gitea`, the dialect it speaks).

- **Picker:** `GET /api/v1/user/repos` lists the token's account's repositories, private ones included, in the Gitea shape. Only that route speaks the Gitea shape; a repository's own JSON is unchanged.
- **Credential:** the token travels as `Authorization: token …` for the API (accepted as a Bearer token) and as Basic through `GIT_CONFIG_*` for git — never argv, never config.
- **Mirror:** brings the code and its history, and the issues, pulls and comments, read in the forge's own JSON (`src/origins/providers/forge-work.ts`) with the real author kept. The origin's card and `GET /api/v1/user/origins` (`carries`) say what did not come: labels and how the app runs (not yet), and its data and secrets (never by default).
- **Write-through:** a comment, an issue or a state change here goes to the other forge first, with the connecting person's token (`rw` needed), and is refused with nothing changed here when the forge is down or says no. A pull is opened there with `createPull` (the contribute path); its merge comes back with the next sync.

## Sign in with one click (#8902)

Type the friend's address at `/settings/origins` and press "Sign in there". If the address is a forge, this forge registers itself there (`POST /oauth/register`, RFC 7591, a public client, kept per user and host), then sends the browser to its approval page with PKCE and the scope `ro` — the least that brings code across. The friend sees who asks and what for, picks the lifetime, and the browser returns to `/settings/origins/callback`. No client id or token is copied. A sign-in begun from `/bring` keeps its link on the flow (`return_query`) and carries straight on with the bring; a callback reaching a browser signed out here signs in and resumes, its state unspent.

- **Refresh:** pick a lifetime other than "Until I revoke it" and the friend's forge issues a rotating refresh token; this forge refreshes before expiry. A spent one (`invalid_grant`) marks the origin needs-reauth, as on every other kind. A token that never expires carries no refresh token and needs none.
- **Registration is per callback address:** if this forge's public URL changes, forget the app and connect again.
- Test: `test/forge-origin-oauth.test.ts` runs two forges through the whole flow.

Not yet: review and check state coming back live, guest rules for a crew on the receiving side, following upstream with one action.

Not yet, in order: migrate an app whole with its run and build, follow upstream between forges with a pull back, and the one-page paste-a-link path. Test: `test/forge-origin.test.ts` runs two forges against each other.

## Issues and comments both ways (#8967)

On a brought repository an issue or comment opened here is written to the origin as the connected account (`src/origins/write-through.ts`), then reflected here under the origin's own number and id.

- **Webhook:** the origin's issues, comments and pulls arrive by a signed delivery to `/api/v1/repos/:owner/:name/origin-hook` (`src/origins/hook.ts`). It is believed for nothing but "look again": the named issue and its thread are read from the origin (`item-check.ts`; a pull goes to `pull-check.ts` and is never imported as an issue). If the origin cannot be read the delivery is refused (404) so it is sent again.
- **Catch-up:** the sync sweep fetches whatever moved since its last clean run, so after the origin was down nothing is lost. Comments are keyed on the origin's id, so a webhook, a sweep and the echo of our own write are one row.
- **Registration:** the hook is asked for once, when a mirror is first imported (and after a pull is proposed upstream), and only a forge origin can be asked. A GitHub or Gitea origin relies on the sweep alone. Asking is idempotent (the origin's hooks are listed first, none is added twice).
- Test: `test/origin-issues.test.ts` runs two forges through write, webhook and catch-up.

## Both doors, and what was exercised

The terminal reaches the same code as the web and the API: `src/tui/screens/issue.ts` and `pull.ts` comment and change state through `addCommentThrough` and `setIssueStateThrough` (`src/actions/issues.ts`), which call `providers.createComment` / `setState` when the repository is a mirror. The one-click sign-in has no terminal path (a forge has no device grant): Connected origins and Origin apps say so and point to the web page, and the terminal connects a forge with a token.

A forge's comments carry no edit time, so `updatedAt` is read when the forge sends one and is the creation time otherwise: an edited comment syncs once the forge reports edits. A thread is paged to its end; one of more than 100,000 comments is a failed sync, never a short one.

The preview of the pull was not exercised: the write-through is proven by `test/forge-origin.test.ts` (two forges in one process, including the origin going down and coming back), not by hand on the preview.
