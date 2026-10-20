# forge for Claude Code

Set `FORGE_URL` (the forge's address, no trailing slash) and `FORGE_TOKEN`
(an `rw` token; `ro` reads only), then add this directory as a plugin
(`claude --plugin-dir plugins/claude-code`). It registers the forge's MCP
server and a `/forge` command: `tell`, `status`, `decide`.

`test/plugins.test.ts` fails when this plugin names an MCP tool the forge does not list, so a rename in `src/http/mcp.ts` cannot leave it behind.
