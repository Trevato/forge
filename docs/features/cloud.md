# Cloud accounts

The forge keeps the provider tokens (a cloud vendor's API token) its repositories use, sealed. Four doors show them, all a forge admin's alone; anyone else finds no such page, screen, tool or route. No door ever returns a secret: a token is typed once, checked, sealed, and never drawn, kept in a note or sent back.

- **Page**: Settings → Cloud accounts, `/settings/cloud`. Each account with what it is used for, when it was verified and last used, and today's vendor calls. Attach, verify, allow writes, rename, rotate, audit and remove are forms on the page.
- **Terminal**: the "Cloud accounts" screen (`src/tui/screens/cloud.ts`), opened from the palette. `a` attaches (token typed masked), `v` re-verifies, `r` rotates, `n` renames, `x` removes. The checks are the page's (`src/actions/cloud.ts`).
- **MCP**: `cloud_accounts` takes no arguments and returns the accounts with each token's use, verification, write permission and today's calls. It counts as a write, so a `ro` token never lists them.
- **HTTP**: `GET /api/v1/cloud/accounts` returns the same body as `cloud_accounts` (both build it with `cloudOverview`).

```
curl -H "authorization: Bearer $FORGE_TOKEN" "$FORGE_URL/api/v1/cloud/accounts"
```

Answers: `401` with no signed-in user, `403` for a read-only token (every vendor call is audited, so listing is a write-scoped act), `404` for anyone who is not a forge admin.

Not done: the route only lists. Attaching, rotating and removing stay on the page and in the terminal, where the token can be typed masked.
