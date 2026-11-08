# Opening /mcp in a browser

`/mcp` is the forge's MCP server: a harness POSTs JSON-RPC to it with a token.

A browser that pastes the address (a `GET` whose `Accept` names `text/html`)
reads a short page in the forge's chrome: what this is, how to connect, and
links to `/llms.txt`, `/.well-known/mcp.json` and Settings › Tokens (a sign-in
link for a reader who is not signed in). The status stays 405 and `allow: POST`
stays.

An MCP client's `GET` (`Accept: text/event-stream`, `*/*`, or no `Accept`) still
gets the bare 405 with `allow: POST` and an empty body. The decision reads
`Accept` only, never the user agent. `DELETE /mcp` is unchanged.
