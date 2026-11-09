# MCP — the forge as a connector

`POST /mcp` is the forge as a Model Context Protocol server: the studio's
verbs as tools, so an assistant a person already talks to can run their forge
from wherever they are. It is the same forge through another door — every
tool calls the action the page calls, with the same checks — and it is built
for a tunnel and a forge that sleeps.

## Shape

- **One short call, one JSON answer.** The Streamable HTTP transport, used
  the plain way: a JSON-RPC request in, `application/json` out. No
  server-sent stream is ever opened (`GET /mcp` is 405), so there is nothing
  for a proxy to cut at a hundred seconds, and nothing to reconnect.
- **The first call wakes it.** A forge scaled to zero is woken by the request
  like any page; a client's retry on a slow first answer is safe, because
  every write is an ordinary forge action and the reads change nothing.
- **A token, never a cookie.** `Authorization: Bearer <forge token>`. A
  browser session is refused even when signed in: a cookie is what a
  cross-site page could ride, and this door has no page. An `ro` token reads;
  an `rw` token acts; a reading tool says so (`readOnlyHint: true`), and a tool without it writes, by MCP's default.
- **What you may not do on a page you may not do here.** A private app is
  "no such app" to someone who cannot write its repository; stopping a run, and knocking
  on an app with `probe`, are a writer's; the terminal's deploys screen `p`
  is the same knock behind the same gate.

## Tools

The complete list, with schemas, is MCP `tools/list` called with a token.
`/llms.txt`, under "## MCP tools", lists only the tools open without a token (one line each, from its `doc`) and counts the rest, pointing on to `tools/list`; signed in, it lists every tool.

Sending a failed webhook delivery again (`redeliver`, #8075) is the terminal's `r` on a hook's Deliveries screen only; the `hooks` tool has no action for it yet.

### Adding a tool

One tool, one file (#5924): `src/http/mcp/tools/<name>.ts` exports `tool`,
its definition and `run`, and nothing else; its arguments' shared helpers
are in `src/http/mcp/shared.ts`. Its line in `/llms.txt` is its `doc`.
Then run `bun scripts/mcp-tools.ts`: it adds one line to the sorted
`tools/index.ts` and writes no docs, so two pulls adding two tools
edit no line in common. `test/mcp-tools.test.ts` holds every tool file to
the same contract and goes red when the index is stale; the
tool's own behaviour is tested in `test/mcp-<name>.test.ts`.

### Room for a new tool

Every session pays for `tools/list` first. It is paged, as the MCP spec
allows: a page holds about 20,000 bytes of tools (`TOOLS_PAGE_BYTES` in
`src/http/mcp.ts`) and carries `nextCursor` while more remain; send it back as
`params.cursor` for the next page. A cursor that names no tool is a `-32602`
error. A client must follow `nextCursor`; the Claude Code and OpenCode
plugins only register `/mcp`, so paging is their MCP client's job. Adding a
tool no longer busts one response, but `test/mcp-size.test.ts` still holds
each page to a 40,000-byte ceiling and a 38,500-byte headroom. Measure before you push with `bun test test/mcp-size.test.ts`;
a failure names the bytes over and the longest descriptions.

- A new door is an `action` or `kind` on the tool that already owns the
  resource before it is a new tool.
- A new tool's description is one sentence.
- A `dryRun` argument is bare `{ type: "boolean" }`: the server's
  `instructions` say once that a tool with `dryRun` plans unless it is `false`.
- The ceiling is the owner's: never raise it in a feature pull.

`flow` with `{ kind: "bugs" }` is such a door (#8973): `{ open, overdue, bugs }`,
each bug `{ repo, number, priority, dueAt }`, soonest due first, at most 100,
from `src/flow/bugs.ts`. An admin sees every repository; anyone else only
public ones, as the terminal's bugs screen does.

Answers are JSON in a text block; most carry a `says` sentence short enough
to relay as it is.

### Asked first in the conversation

A tool marked `(admin scope)` is listed and called only with an admin-scope
token. An admin whose token is short of it reads, on the first `tools/list`
page's `_meta.hidden` and in `initialize`'s instructions, one sentence naming
the hidden tools and the two ways to them: an admin-scope token, or a confirm
in the conversation (#7650).

The forge's own agent (a via token) asks before an outward-facing or
hard-to-undo action: release and rollback, archive and delete, subscriptions
and budgets, secrets, invites, SSH keys, and every admin-scope tool — the one
list is `ASKING` in `src/crew/conversation_confirm.ts`. Such a call does
nothing and answers `{ needs_confirm, tool, does, says }`: `does` is one
sentence of what it will do, said to the person; a secret's value is never
repeated in it, and an argument cannot break it onto a new line. A tool whose
only reading action is `list` (`secrets`, `app_env`, `ssh_keys`, and
`proposal_tokens` by its `verb`) asks for its writes only. A `confirm` turn is
written to their conversation.

The person says yes from their own browser session, same-origin, never a
token, so never the agent: Settings → Confirms (`/settings/confirms`), the
terminal's Confirms (`y`), or `POST /api/v1/conversation-confirms/:id`. All
three call `sayYes` in `src/actions/conversation_confirms.ts`. Before the
yes the person reads every argument as the call will run (#8230): the page's
row folds open on them, and the terminal's yes dialog repeats them under the
sentence. Only genuine secrets are hidden there — a sealed secret's or app
variable's or cloud token's `value`, and any `token`, `secret`, `password` or
`credential` — so a public key or a limit's `key` and `value` are read whole.
A call whose arguments are too large to read whole is refused and kept
nowhere. It does the
stored call with its stored arguments once, as the person via the forge's
agent, and writes a `tool` turn naming the undo when the action has one. A
result shown only once (`mint_invite`'s link, `claim_link`, a minted proposal
token) is answered to the person and kept in the turn only as a sentence. A
second yes is 409 `answered`; a yes 10 minutes on is 410 `expired`. A confirm
left unanswered for 10 minutes is swept: its arguments are cleared and it no
longer counts toward the 50 a conversation may hold. An admin-scope tool is
reached this way only by a person who is an admin.

## Arguments, in full

`tools/list` keeps every argument description to 60 bytes (`test/mcp-size.test.ts`
enforces it); `dryRun` reads `false to apply` on every tool that takes it. The
longer sentences:

- `dryRun`: plans unless it is `false`; anything else changes nothing. `limb` applying takes an admin token.
- `signup`: the terminal's Invite links screen does the same: `s` picks a mode, shows the plan (from → to) and changes it after a confirm, for a forge admin who is a person.
- `tell.from`: a path on this forge the issue links to, like `/alice/notes/pulls/3`. `tell.context`: where this was told from, for the builder.
- `spawn.reveal`, `claim_link.reveal`: put the live claim link in the answer (default false); it is a secret, only when its person reads it. `spawn.fresh`: a fresh app beside the copied ones. `spawn.followMode`: `tell-me` (default) tells the owner in their inbox when this forge's code moves; `take-updates` opens a pull with the new code, and a person merges it. `spawn.size`: recorded only, not enforced. `spawn.keepAccess`: stay an owner once claimed.
- `commits.ref`: branch, tag or commit; the default branch when absent. `report.page`: the http(s) address where the problem was seen. `plan.issues.pillar`: the pillar served, as `"P0"` or `"P0 Trust"`; `later: true` means no pillar and needs `why`.
- `explore.q`: words, plus `kind:app|person|forge` and `sort:score|forks|ships|likes|use|fresh|name`, `updated:1d|7d|30d` (only what moved in that window), `owner:name` and `archived:yes`. `query` is the same argument; `q` wins when both are given.
- `archive.repos`: several repositories, as `owner/name`, to archive in one operation.
- `milestones.issue`: the number of an issue that waits for others; the limbs when absent. `watch.issue` is the same number; `watch.watch` false stops watching, anything else watches.
- `limb.reason` (close): why it is not being done, in one sentence. `limb.pillar` (resume): the pillar to return it under. `limb.under` (raise, lower): `top` or a milestone number, only when the limb sits in several places.
- `asks.hide_kinds`, `asks.hide_people`, `feed.*`: leave out these kinds or usernames; replaces your saved filter.
- `audit.repo`: one app, as `owner/name`; every app you can see when absent.
- `model_ceiling.dailyUsd`/`perRunUsd`: 0.01–10000; both null clears; one null is refused. `model_grant.usdPerMonth`: 0 takes the grant back. `account_role.usdPerMonth`: omit or null for none.
- `hold.why`: why, in one line; it shows on the pull. `runs.limit`: how many, 1 to 50; 20 when absent.
- `boards.step`: with `panel`, seconds per bucket, or a count of `s`, `m`, `h` or `d`. `access.since`: ISO time; default a day, max 14 days.

## Connecting

Mint a token under **Settings → Access tokens** (`rw` to act, `ro` to watch),
then, in Claude Code:

```sh
claude mcp add --transport http forge https://<your-forge>/mcp \
  --header "Authorization: Bearer <token>"
```

Any MCP client that can send a header works the same way.

## The server card

`/.well-known/mcp.json` names the server (`name`, `version`, `endpoint`,
`transport`, `protectedResourceMetadata`, `documentation`, `openapi`,
`tokenFreeTools`)
and the build that answers: `commit`, the full commit the forge runs
(`FORGE_COMMIT`, or `FORGE_APP_COMMIT` on a preview), or `null` when nothing
says. `version` is `dev` on a preview, so `commit` is how an agent tells two
previews apart.

## Attaching with OAuth

Clients that cannot paste a header — the Claude apps, Grok's connectors —
attach by OAuth. The forge publishes its discovery documents
(`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`),
takes dynamic client registration at `/oauth/register`, and runs the
authorization-code flow with PKCE `S256` (public clients, no secret, no
refresh token).

1. The client sends you to `/oauth/authorize`. If you are not signed in you
   sign in and come back. The page names the client and the host it will
   return to, and asks for **Read** (`ro`) or **Read and act** (`rw`), a name
   for the token, and how long it lasts (until revoked by default).
2. On **Allow** the forge redirects to the redirect address the client
   registered — exactly, never a look-alike — with a one-time `code` and the
   client's `state`. A code works once, for 60 seconds, and is stored hashed.
3. The client posts the code and its PKCE verifier to `/oauth/token` and
   receives a bearer token: the same kind Settings mints. It is listed under
   Settings and revoking it there cuts the connector off.

**The Claude app** (web or phone): Settings → Connectors → Add custom
connector, URL `https://<your forge>/mcp`. Claude registers itself with the
callback `https://claude.ai/api/mcp/auth_callback`; approve it on the forge's
page. **Grok**: Connectors → Add custom connector, the same `/mcp` URL;
approve the page it opens. Pick `ro` unless the connector should be able to
`tell` and `plan`.

The token's scope is the whole of its authority: a connector holding `ro`
can call `apps` and is refused `tell`.

`src/http/oauth.ts`, `src/core/oauth.ts`, `src/web/pages/oauth.ts`,
`test/oauth-flow.test.ts`.

`src/http/mcp.ts`, `src/http/mcp/tools/`, `src/actions/tell.ts`, `test/mcp.test.ts`.

## `plan`

Opens several small issues and their links in one transaction. Each item is
`{ key, title, body?, blockedBy? }`; `blockedBy` lists keys of the same call or
numbers of issues already open. A loop, an unknown key, an unknown number, an
over-long title or body, or more than 12 items refuses the whole plan, naming
the item, and nothing is opened. Issues belong to the token's owner and emit
the same events as opening and linking one by one. It needs an `rw` token.

Where the app has pillars (docs/PLANNING.md), every item also says what it
is for, or the whole plan is refused (`no_pillar`), naming the item and the
pillars there are:

- `pillar`, the one it serves, by short form or name (`"P0"` or
  `"P0 Trust"`): the pillar's umbrella issue then waits for it.
- `later: true` with `why`, one sentence: it serves no pillar now. It opens
  blocked by the Later gate, so it is not on the ready list, its body opens
  with `**Later:**` and the sentence, and the answer lists it in `later`.

```json
{ "app": "trevato/forge", "issues": [
  { "key": "review", "title": "Every agent pull is reviewed", "pillar": "P0" },
  { "key": "slider", "title": "The profit slider", "later": true,
    "why": "Money lines serve no pillar now." } ] }
```

answers

```json
{ "says": "Opened 2 issues: review is #7, slider is #8. #8 waits behind the Later gate #5.",
  "opened": [{ "key": "review", "number": 7 }, { "key": "slider", "number": 8 }],
  "ready": [7], "later": [8] }
```

An app with no pillars takes no `pillar` (`unknown_pillar`), and `later`
needs the gate to exist (`no_later_gate`).

```json
{ "app": "alice/game", "issues": [
  { "key": "board", "title": "Draw the board", "body": "8x8 grid" },
  { "key": "moves", "title": "Legal moves" },
  { "key": "play",  "title": "Play a game", "blockedBy": ["board", "moves"] } ] }
```

answers

```json
{ "says": "Opened 3 issues: board is #7, moves is #8, play is #9.",
  "opened": [{ "key": "board", "number": 7 }, { "key": "moves", "number": 8 }, { "key": "play", "number": 9 }],
  "ready": [7, 8], "later": [] }
```

## Cards, the contract and the plugins (#1116)

- **Cards.** `apps`, `new_app`, `now`, `asks`, `milestones`, `waves` (one wave), `map`, `feed`, `pull`, `pulls` and `asked` name a `ui://` resource in
  `_meta.ui.resourceUri` (MCP Apps, SEP-1865): `ui://forge/app`, `run`,
  `decision`, `wave`, `map`, `feed`, `pull`, `pulls`, `asked`. The Plan card (`map`) shows one row per pillar with
  its ready, working and waiting counts, and the first five ready issues linked
  to their pages; it has no actions. The decision card's rows link to the pull or issue
  they are about (a paused repository's row has none).
  The Apps card (`apps`) links each `owner/name` row to the app's page on the forge and adds a
  linked production row when the app has an http(s) URL; the `new_app` card links its
  Production row the same way. Any other address stays plain text, never a link.
  `resources/list` and `resources/read` serve one small
  sandboxed page, which draws the `structuredContent.card` model that the
  tool result carries, with `textContent` only. The model is built in
  `src/web/studio/cards.ts`. A card's
  buttons ask the host to call a tool (`asks_act`, `say`, `stop`, `tell`); the
  host decides, and every call is checked as any other. A card with a
  words action shows one text field: **Tell <app>** (app card) sends the
  words to `tell` as `text` with `repo` and `context.said`; **Redirect**
  (decision card) sends them to `say` with the first ask's `repo`, `number`
  and `text`. Empty words send nothing. `asks` rows carry `repo`
  (`owner/name`) beside `number` for this.
- **Contract.** `GET /contract/openapi.json` is OpenAPI 3.1 for the routes
  the manifest (`here`) names, plus `POST /mcp`. It also describes planning: `GET …/map`, `POST …/plan`,
  `POST …/issues/{number}/dependencies` and
  `DELETE …/issues/{number}/dependencies/{blocker}`. `test/openapi.test.ts` fails
  when the manifest names a route it lacks.
- **Where a tell came from.** `tell` takes `context`: `page` (http/https),
  `run`, `commit` (hex) and `said` (the person's words). Malformed context is
  refused; the rest is appended to the issue body. `tell` also takes `from`: a
  same-forge path (at most 512 characters, like `/alice/notes/pulls/3`) that
  becomes the "Told from" link on the issue; a bad one is refused. It differs
  from `context.page`, which is any http(s) address appended as context, not
  linked as the origin.
- **`ready` and `startable`.** `map` (and `GET …/map`) carries both. `ready` is
  every open issue with nothing open in front, held or working ones included,
  and the page's Ready now section reads it. `startable` is the numbers from
  `ready` that a builder may begin: no assignee, not working, held, parked or
  deferred, and no filter holding them (`ready[].held`), in `ready`'s order.
  `counts.ready` equals `startable.length`; read `startable`, not `ready`, to
  count what can start. The page's counts line still counts every ready
  issue, assigned ones too. `GET /api/v1/map` (the lanes) carries `startable`
  too but unfiltered: it skips the filter holds, so a hot-file issue is
  startable there and not in the repository's own map.
- **Plugins.** `plugins/opencode` and `plugins/claude-code` register this
  server and add a `forge` command (new, tell, status, decide, plan, preview,
  pulls, runs, log, asked). They hold no logic. The Claude Code plugin has two
  entries: `forge` sends no Authorization header, so Claude Code signs in
  through the OAuth flow (the default); `forge-token` sends `FORGE_TOKEN` as a
  bearer, for scripts.
  Install it without a clone: `/plugin marketplace add <FORGE_URL>/trevato/forge.git`
  (the clone URL as the forge prints it), then `/plugin install forge@forge`
  (the root `.claude-plugin/marketplace.json` names the marketplace `forge`).
  From a clone, `claude --plugin-dir plugins/claude-code` is the local way.
