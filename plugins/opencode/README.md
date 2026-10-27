# forge for OpenCode

Copy `forge.ts` into `.opencode/plugin/` (or list this package under `plugin`
in `opencode.json`), and set `FORGE_URL` and `FORGE_TOKEN` (make the token at `/settings/tokens` on the forge, which shows the line with its own address filled in):
`mkdir -p .opencode/plugin && cp plugins/opencode/forge.ts .opencode/plugin/ && FORGE_URL=<url> FORGE_TOKEN=<token> opencode`. It registers the
forge's MCP server and the `forge` command: `tell`, `status`, `decide`, `plan`,
`preview`, `pulls`, `runs`, `log`.
`/forge plan` shows the planner's next wave (the first wave-proposal row of `asks`);
`/forge plan approve`, `redirect <words>` or `later` steers it through `asks_proposal`,
applied only after you say yes. Only the owner may act on a proposal.

`/forge preview <url>` says in two lines the app, environment, pull, check
and who is working at that URL. `/forge pulls <app>` lists the app's open
pulls with their check.

`/forge runs <app>` says what the crew is doing on the app: the running runs
and the last three finished, one line each (kind, issue or pull, state, how
long), through MCP `runs`. `/forge log <app> <run>` relays that run's last 40
lines verbatim, through MCP `run_log`.

Code Mode can also read `GET /contract/openapi.json`.

`test/plugins.test.ts` fails when this plugin names an MCP tool the forge does not list, so a rename in `src/http/mcp.ts` cannot leave it behind.
