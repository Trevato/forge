# forge for OpenCode

Copy `forge.ts` into `.opencode/plugin/` (or list this package under `plugin`
in `opencode.json`), and set `FORGE_URL` and `FORGE_TOKEN`. It registers the
forge's MCP server and the `forge` command: `tell`, `status`, `decide`.
Code Mode can also read `GET /contract/openapi.json`.
