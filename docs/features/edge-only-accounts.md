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
