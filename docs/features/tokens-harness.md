# Which harness holds a token

A token minted through the OAuth endpoint (`/oauth/token`, when a harness such
as Claude Code connects) is listed with the registered name of the client that
holds it, so you can tell who can act as you. A token you made by hand shows
nothing extra.

- **Settings › Tokens**: under the token's name, "<client> · Signed in through
  OAuth; renews itself until you delete it". The name is escaped.
- **`GET /api/v1/tokens`** and MCP **`tokens`**: each token carries
  `oauthClient`, the client's name, or `null` for a hand-made token.
- **Terminal, sign-ins screen**: the row reads `<name> · <scope> · <client>, renews itself`.

It appears for every token the code exchange or a refresh minted while the
client is registered. A token from before OAuth tokens were marked is listed as
hand-made. "Renews itself" means the harness swaps it with its refresh token
before it lapses; deleting it ends that, see [OAuth refresh](oauth-refresh.md).
