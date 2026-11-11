# forge for Claude Code

One command, printed by the forge itself (`/llms.txt`, Settings › Tokens), with its own address and no clone:

```
claude plugin marketplace add $FORGE_URL/plugins/claude-code/marketplace.json && claude plugin install forge@forge
```

The forge serves that marketplace manifest (name `forge`, one plugin `forge`, fetched by Claude Code as the `plugins/claude-code` subdirectory of the forge's public source repository). Inside Claude Code, the same from the repository: `/plugin marketplace add $FORGE_URL/trevato/forge.git` then `/plugin install forge@forge`. Then set `FORGE_URL` (the forge's address, no trailing slash) in your environment. From a clone, `claude --plugin-dir plugins/claude-code` loads it locally instead. It registers the forge's MCP
server and a `/forge` command: `new`, `tell`, `status`, `decide`, `archive`, `undo`, `plan`, `preview`,
`pulls`, `runs`, `log`, `asked`.

**Sign in (nothing to copy).** The `forge` server sends no Authorization header, so Claude Code takes the forge's OAuth sign-in: open `/mcp` in Claude Code, choose `forge`, and approve in the browser.

**A token (for scripts).** Also set `FORGE_TOKEN` (an `rw` token; `ro` reads only; make one at `/settings/tokens` on the forge, which also shows this line filled in) and use the `forge-token` server, which sends it as a bearer. `forge-token` defaults a missing `FORGE_TOKEN` to empty, so an OAuth-only user sees no missing-variable error; that entry then just sends an empty bearer and is refused, so leave it unused. A plugin.json cannot make a header conditional, so the two are separate entries; `forge` is the default.

`/forge archive <app>` plans archiving the app, then archives it after you say yes (put away, not deleted; the receipt says how to wake it). `/forge decide all <dismiss|ship|close> [kind]` plans the same action over every waiting ask (of that kind), says how many and which, applies after a yes and prints the `operation` id; `/forge undo <operation>` reverses it.

`/forge plan` shows the planner's proposed wave in three lines. `/forge plan approve`, `/forge plan redirect <words>` or `/forge plan later` answers it, after you confirm.

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

`test/plugins.test.ts` fails when this plugin names an MCP tool the forge does not list, so a rename in `src/http/mcp.ts` cannot leave it behind.
