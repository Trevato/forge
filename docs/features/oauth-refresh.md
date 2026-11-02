# OAuth refresh

When the person chose a lifetime for the token (`lifetime_s`), the code
exchange also returns a `refresh_token`. A token with no lifetime gets none and
the answer is unchanged.

```
curl -X POST https://<forge>/oauth/token \
  -d grant_type=refresh_token -d refresh_token=<rt> -d client_id=<id> [-d scope=ro]
```

- The answer is a new `access_token` and a new `refresh_token`; the old pair stops working.
- A spent refresh token presented again ends the whole family (OAuth 2.1 §4.3.1)
  and leaves a `token.deleted` event with `via: oauth_refresh_reuse`.
- `scope` may only narrow (`rw` to `ro`); more is `invalid_scope` and spends nothing.
- `POST /oauth/revoke` with either token ends the family.
- Refresh tokens live 90 days from their issue, are stored hashed (`oauth_refresh`),
  and are bound to the client that got them. Sign-in-only (OpenID) grants get none.
