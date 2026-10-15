# forge for Claude Code

Set `FORGE_URL` (the forge's address, no trailing slash) and `FORGE_TOKEN`
(an `rw` token; `ro` reads only), then add this directory as a plugin
(`claude --plugin-dir plugins/claude-code`). It registers the forge's MCP
server and a `/forge` command: `tell`, `status`, `decide`.
