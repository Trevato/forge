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

## Connect Claude Code from anywhere

Settings › Tokens, "Connect your harness", offers two lines that work outside a
clone, while the forge's own source repository is public on this forge. That
repository is the one an admin names (`PATCH /api/v1/admin/settings` with
`{"forgeRepo": "owner/name"}`), else `FORGE_REPO`:

    /plugin marketplace add <forge address>/<owner>/<name>.git
    /plugin install forge@forge

Run them inside Claude Code; then sign in through `/mcp`. The same two lines
show on the terminal's screen for a token you just made (Signed in › `m`),
wrapped whole; `a` and `i` copy them. While no source is named, or it is
private, they are not shown, since a stranger could not run them; the
`--plugin-dir` line, for a clone, is always shown. The card at
`/.well-known/mcp.json` and `/llms.txt` name the same repository. The address
is the forge's public one, the same on the page and in the terminal, and is
escaped.
