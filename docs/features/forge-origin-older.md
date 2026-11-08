# Connecting a friend's forge, whatever release it runs (#9388)

`/settings/origins` leads with **Another forge**: its address and a token made on it (`<their forge>/settings/tokens`, read is enough; private repositories come with it), or **Or sign in there** for one click.

`/bring` with a link to a forge you have not connected shows **Connect that forge first** on the same page: paste a token (or sign in there), and the app starts coming across at once. The link is kept through the sign-in (`then=bring&link=…`, the link checked as a short http(s) URL, the return always a path on this forge).

## Older forges

A forge from before `/api/v1/version` (0.5.x) is recognised by two answers no other software gives together: `/api/v1/health` (`ok`, a dotted `version`, a `commit`) and `/api/v1/here` (`here`, `actions`). It is stored like any forge (`software = forge`). Without `/api/v1/user/repos`, its repositories are listed from `GET /api/v1/repos` with the token, keeping the account's own, private ones included (`src/origins/providers/forge.ts`, at most 10 pages per call). Test: `test/forge-origin-older.test.ts` runs a fixture of such a forge's answers.

Measured against real old code in containers, and compared with the live forge-apps.benjivers.com by anonymous reads only: [the compatibility matrix](forge-origin-compat.md). There is no "needs a newer release" error either: a forge that matches neither fingerprint is refused as unrecognised.

## Connecting from an older forge

A forge older than 0.7.346 has no forge provider, so it cannot start a connection to another forge. Connect it from the newer forge instead: that forge's `/settings/origins` → **Another forge** reaches the older one today. Upgrading the older forge to 0.7.346 or later lets it connect outward too. `/settings/origins` says the same in one line under Another forge (`test/web-origins.test.ts`).

## Tokens and plain http

A token is sent to the forge named by the link, so `http:` links are refused for it (page and terminal) unless `FORGE_DEV=1`; the one-click sign-in still works. `connectSite` in `src/origins/bring.ts` decides.

## In the terminal

Bring an app (palette) with a link to an unconnected forge asks for its token, masked, connects, and carries on with the same link (`src/tui/screens/bring.ts`). Connected origins (`c`) takes an address and a token as before. Both are for a person's own account, never an agent's.

## One accent

Another forge's Connect is the only primary button on the origins page; the other paths' buttons are plain. On `/bring`, the link form is plain while the connect card is showing, and external links use the shared button component.
