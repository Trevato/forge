# forge for OpenCode

Copy `forge.ts` into `.opencode/plugin/` (or list this package under `plugin`
in `opencode.json`), and set `FORGE_URL` and `FORGE_TOKEN`. It registers the
forge's MCP server and the `forge` command: `tell`, `status`, `decide`, `plan`.
`/forge plan` shows the planner's next wave (the first wave-proposal row of `asks`);
`/forge plan approve`, `redirect <words>` or `later` steers it through `asks_proposal`,
applied only after you say yes. Only the owner may act on a proposal.
Code Mode can also read `GET /contract/openapi.json`.

`test/plugins.test.ts` fails when this plugin names an MCP tool the forge does not list, so a rename in `src/http/mcp.ts` cannot leave it behind.
