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
  an `rw` token acts; the tools say which they are (`readOnlyHint`).
- **What you may not do on a page you may not do here.** A private app is
  "no such app" to someone who cannot write its repository; stopping a run, and knocking
  on an app with `probe`, are a writer's.

## Tools

| tool           | does                                                                                              | writes |
| -------------- | ------------------------------------------------------------------------------------------------- | ------ |
| `apps`         | the apps you can see: live or not, where served, how each runs itself, what is working            |        |
| `tell`         | a sentence becomes an issue, a builder is picked, a run starts on the crew's next tick            | yes    |
| `say`          | speak on an issue or a pull; a working builder hears it as its next step                          | yes    |
| `now`          | what the crew is doing right now: who, on what, since when, at what cost; a planner that declined the direction and waits for you comes first (`run: null`, its words in `says`) |        |
| `stop`         | stop one run by its id from `now`                                                                 | yes    |
| `audit`        | who can do what, per app, read from its contract.json in git: yes, own or no per door, and whether outsiders may direct its crew (`crewOutsiders`) |        |
| `outsiders`    | `{ repo, on?, dryRun? }`: whether people who cannot write may direct the crew; with `on`, planned first (`dryRun` is true unless `false`); set only by the app's admin with an admin token, never an agent | yes    |
| `probe`        | knock on a running app's doors as nobody, a user and an admin; the ones that disobey its contract |        |
| `following`    | where a fork stands against what it follows, and what the crew is doing about it                  |        |
| `spawn`        | `{ name, apps?, crew?, dryRun? }`: a child forge, planned first (`dryRun` is true unless `false`); an admin's, and an `ro` token may plan but not make | yes    |
| `take_updates` | a fork takes its parent's updates when git can do it alone; a conflict is refused                 | yes    |
| `converge`     | the fork's crew merges where both sides changed the same files; comes back as a pull              | yes    |
| `asked`        | `{ repo?, show?, order? }`: what people asked the crew for, by default nothing merged yet and oldest first: who and when, the pulls that close it, the crew's last activity, waiting/building/shipped/closed, stale when not shipped in three days and flagged when stale with nothing built; repositories you can write |        |
| `app_members`  | `{ repo, members?, dryRun? }`: the people a private app names, who may enter it and its previews and nothing else; a writer (never an agent) changes the list with an admin-scope token | yes    |
| `front_page`   | `{ pinned?, hidden?, dryRun? }`: the front page as a stranger sees it, ranked, with numbers; a site admin sets what is pinned (first public one featured) and hidden | yes    |
| `map`          | an app's plan: ready now, waiting on what, the critical path, where the crew is, parked twice and why (`app`) |        |
| `usage`        | `{ repo, days? }`: what the crew's runs spent — tokens, cost, wall time — by subscription, agent, issue, and each account's 5-hour and weekly standing; a writer's |        |
| `link`         | `{ app, issue, blockedBy }`: the issue waits for another; loops and cross-repository are refused  | yes    |
| `unlink`       | `{ app, issue, blockedBy }`: the issue stops waiting for it                                       | yes    |
| `hold`         | `{ app, pull, why?, release?, dryRun? }`: hold a pull so no rule reviews or lands it, or let it go; a person who can write, never an agent; plans unless `dryRun: false` | yes    |
| `plan`         | `{ app, issues }`: open up to 12 linked issues, all or none (see below)                           | yes    |

Answers are JSON in a text block; most carry a `says` sentence short enough
to relay as it is.

## Connecting

Mint a token under **Settings → Access tokens** (`rw` to act, `ro` to watch),
then, in Claude Code:

```sh
claude mcp add --transport http forge https://<your-forge>/mcp \
  --header "Authorization: Bearer <token>"
```

Any MCP client that can send a header works the same way. The Claude apps on
the web and the phone add custom connectors through OAuth, which the forge
does not speak yet; that is the next step here, and it changes nothing above
— the same tools, a token the forge mints for the connector instead of one a
person pastes.

`src/http/mcp.ts`, `src/actions/tell.ts`, `test/mcp.test.ts`.

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
