# Edge-only accounts

An account the platform edge made (or one linked to an edge login) with no password, no passkey and no parent link can sign in only through the edge. Switching `signin.edge` off would lock it out.

- **Web:** an admin's Settings → Accounts shows a card at the top naming each such account, admins first, then oldest, with a nudge to add a passkey at Settings → Passkeys. The card is gone when the list is empty. Non-admins and guests never see it.
- **Terminal:** the palette entry "Edge-only accounts" (admins only) lists the same accounts, from the same `edgeOnlyAccounts`.
- **"Edge-made"** is one rule: a `user.created` event whose payload `via` is `edge` (read with `json_extract`, as `parseOrigin` does), or an edge link.

## Switching the edge off

1. Wait until the card and the terminal screen are empty.
2. Turn `signin.edge` off on a preview first, with the owner present.
3. Roll back by setting it on again in Settings → Capacity.

## Dry run

Settings → Capacity → "Dry run" on the `signin.edge` row (or `dry_run: true` on the capacity PUT) lists who would be locked out and refuses while the admin themselves would be. Settings → Accounts shows how many accounts sign in without the edge. A passkey added from a browser the edge signed in links that login to the account (`edge_link`).

## When the edge is gone (#11802)

Every account the edge made is mapped once to the login it forwarded, in `edge_link` (migration `20261112180000-edge-handover`), and an account the edge signs in by name is mapped on that sign-in. So the record of who came through the edge is a row, not an inference.

An edge-made account has a noreply address, so email recovery cannot reach it. For a mapped account that is not an admin and has no way in of its own, the Accounts card offers **Way-back link for <name>**: an admin presses it and the link is shown once on the page (`Cache-Control: no-store`). Hand it over by a channel you trust. It works once, for 7 days, and opens the `/recover` step: register a passkey, and the person is signed in with a session of the forge's own. Making another link replaces the first. In the terminal, the palette's **Way-back links** (admins only) lists the same accounts; Enter makes the link with the same action and shows it once on a screen of its own, `y` copies it. Only its SHA-256 hash is stored (`edge_handover`). An admin who signs in only through the edge adds a passkey while the edge still answers. Switching `signin.edge` off already refuses to strand them.

## Removing the middleware from the Ingress

The forwardAuth middleware lives in the platform's gitops repository (`apps/forge/prod/manifests.yaml`, walked in #8948), not here. A person applies the change:

1. Wait until the card and the terminal screen are empty, or until each person left has been handed a way-back link.
2. On the forge's Ingress, delete the `traefik.ingress.kubernetes.io/router.middlewares` entry that names plat-auth. Keep any other middleware in that annotation. Then let the standby reconcile apply it, or apply it by hand.
3. Check: `curl -sI https://<forge>/healthz` answers 200, and so does `/` signed out. Signing in with a passkey works.
4. Unset `FORGE_EDGE_TOKEN` (or turn `signin.edge` off). The edge's headers are then a claim anyone could write, and they are ignored.
5. Delete the `plat-auth` row from `FOOTING` in `src/system/footing.ts` and regenerate the table in `docs/OPERATING.md`.
