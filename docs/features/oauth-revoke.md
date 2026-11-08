# OAuth revoke

A harness that disconnects ends its own token: `POST /oauth/revoke`
(RFC 7009). Both `/.well-known/oauth-authorization-server` and
`/.well-known/openid-configuration` name it as `revocation_endpoint`.

## Calling it

```
curl -X POST https://<forge>/oauth/revoke -d token=<access_token>
```

The body is a form (`token=…`) or, leniently, JSON (`{"token":"…"}`), at most
16 KiB. No cookie and no client secret: the token is the proof.

It answers an empty `200` for every token it is given: one it ended, an
unknown one, a repeat, and a personal token made in settings (which it does
not touch). It never says whether the token existed. `413` for a body past
the cap; `429` with `Retry-After` past 60 requests a minute per client address
(IPv6 by its /64) or 600 a minute across the forge.

A revoked token is refused at once by `/api/v1` and `/mcp`, and a
`token.deleted` event (`via: oauth_revoke`) lands in the audit trail.

## What it can end

Only tokens the OAuth token endpoint minted: each is marked in the
`oauth_token` table, which cascades away with the token. Tokens minted before
that migration carry no mark and cannot be revoked here; end them in settings.

## The person's side

No new screen is needed. A person's connected harness is a row in the token
list (the settings page, and the terminal's sign-ins screen with `d`), which already deletes any
token, OAuth-minted or personal; deleting it removes its `oauth_token` row by
cascade, and the harness's next call is refused.
