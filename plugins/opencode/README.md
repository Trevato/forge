# forge for OpenCode

Fetch `forge.ts` into `.opencode/plugin/` (or list this package under `plugin`
in `opencode.json`), and set `FORGE_URL` and `FORGE_TOKEN` (make the token at `/settings/tokens` on the forge, which shows the line with its own address filled in):
`mkdir -p .opencode/plugin && curl -fsSo .opencode/plugin/forge.ts <forge>/plugins/opencode/forge.ts && FORGE_URL=<forge> FORGE_TOKEN=<token> opencode`, where `<forge>` is the forge's own origin (it serves this file). It registers the
forge's MCP server and the `forge` command: `new`, `tell`, `status`, `decide`, `plan`,
`preview`, `pulls`, `runs`, `log`, `asked`.
`/forge plan` shows the planner's next wave (the first wave-proposal row of `asks`);
`/forge plan approve`, `redirect <words>` or `later` steers it through `asks_proposal`,
applied only after you say yes. Only the owner may act on a proposal.

`/forge new <name> <words>` makes an app named `<name>` whose first issue is the words, through MCP `new_app`, after you confirm; it answers with the app's page and the next step. It needs an `rw` token (an `ro` token is refused). When the forge refuses (the name is taken, the account is unverified, a limit is reached), it says the forge's own words in one line, offers another name when the name is taken, and never retries without asking.

`/forge preview <url>` says in two lines the app, environment, pull, check
and who is working at that URL. `/forge pulls <app>` lists the app's open
pulls with their check.

`/forge runs <app>` says what the crew is doing on the app: the running runs
and the last three finished, one line each (kind, issue or pull, state, how
long), through MCP `runs`. `/forge log <app> <run>` relays that run's last 40
lines verbatim, through MCP `run_log`.

`/forge asked [app]` says what you asked the crew for and what became of
each, shipped ones included: one line per ask (what, waiting/building/shipped/closed,
the pull that closes it, and the outcome sentence: landed, who is building,
parked and why, failed), flagged ones first, through MCP `asked` with
`show: "all"`; with an app, only that app's asks.

Two ways to connect. With only `FORGE_URL` set, the plugin registers the MCP
server with no Authorization header and `oauth: {}`, so OpenCode signs in
through the forge's OAuth (run `opencode mcp auth forge`). With `FORGE_TOKEN`
set too, it sends the token as a bearer header and no sign-in is needed. With
neither set, it registers nothing.

Code Mode can also read `GET /contract/openapi.json`.

`test/plugins.test.ts` fails when this plugin names an MCP tool the forge does not list, so a rename in `src/http/mcp.ts` cannot leave it behind.
