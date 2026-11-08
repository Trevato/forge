# OpenAPI and OAuth

`GET /contract/openapi.json` describes three ways to sign in, under `components.securitySchemes`:

- `token`: an HTTP bearer token (a personal or proposal token).
- `oauth2`: the authorization-code flow (with PKCE) and its refresh. Scopes are the ones in `OAUTH_SCOPES` (`ro`, `rw`); the document is built from that list, so it cannot drift.
- `openid`: OpenID Connect discovery, at `/.well-known/openid-configuration`. No operation requires it; it is for discovery only.

Every operation that needs a login lists `token` and `oauth2`; either one is enough. Each `oauth2` requirement names one scope: `ro` on a GET, `rw` on anything else (`rw` reads too). A client asks for one scope, `ro` or `rw`: the forge grants a single scope, so ask for `rw` if the client will write.

## A generated client signs in

1. Send the person to `authorizationUrl` (`/oauth/authorize`) with `response_type=code`, your `client_id`, `redirect_uri`, `scope` (`ro` or `rw`), `state` and a PKCE `code_challenge` and `code_challenge_method=S256`.
2. The person approves; the forge redirects back with `code`.
3. POST `code`, `code_verifier` and `grant_type=authorization_code` to `tokenUrl` (`/oauth/token`). The answer holds `access_token` and, when the grant has one, `refresh_token`.
4. Call the API with `Authorization: Bearer <access_token>`.

## Refresh

When the access token expires (a `401`), POST `grant_type=refresh_token` and the `refresh_token` to `refreshUrl`. It is the same endpoint as `tokenUrl`. Keep the new refresh token the answer returns.
