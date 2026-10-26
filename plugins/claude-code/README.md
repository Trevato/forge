# forge for Claude Code

Set `FORGE_URL` (the forge's address, no trailing slash) and `FORGE_TOKEN`
(an `rw` token; `ro` reads only; make one at `/settings/tokens` on the forge, which also shows this line filled in), then add this directory as a plugin
(`claude --plugin-dir plugins/claude-code`). It registers the forge's MCP
server and a `/forge` command: `tell`, `status`, `decide`, `plan`, `preview`,
`pulls`.

`/forge plan` shows the planner's proposed wave in three lines. `/forge plan approve`, `/forge plan redirect <words>` or `/forge plan later` answers it, after you confirm.

`/forge preview <url>` says in two lines the app, environment, pull, check
and who is working at that URL. `/forge pulls <app>` lists the app's open
pulls with their check.

`test/plugins.test.ts` fails when this plugin names an MCP tool the forge does not list, so a rename in `src/http/mcp.ts` cannot leave it behind.
