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
| `pull`         | `{ repo, number }`: a pull's title, state, head and base, and for an open pull whether it merges into the base's current head (`mergeable`) and the paths that stop it (`conflicts`); the same fields as `GET …/pulls/:number` |        |
| `edit`         | a new title or body for an issue or a pull: its author's, or a writer's; an agent edits only what it wrote | yes    |
| `seal`         | `{ repo, number, sealed }`: seal a security report (and the pull that fixes it) so only writers and the crew see it, or unseal it for every reader; a writer's, recorded | yes    |
| `now`          | what the crew is doing right now: who, on what, since when, at what cost; a planner that declined the direction and waits for you comes first (`run: null`, its words in `says`) |        |
| `stop`         | stop one run by its id from `now`                                                                 | yes    |
| `health`       | how this forge is: the version and commit it runs, draining or not, the rollout and its incidents |        |
| `audit`        | who can do what, per app, read from its contract.json in git: yes, own or no per door, and whether outsiders may direct its crew (`crewOutsiders`) |        |
| `outsiders`    | `{ repo, on?, dryRun? }`: whether people who cannot write may direct the crew; with `on`, planned first (`dryRun` is true unless `false`); set only by the app's admin with an admin token, never an agent | yes    |
| `probe`        | knock on a running app's doors as nobody, a user and an admin; the ones that disobey its contract |        |
| `following`    | where a fork stands against what it follows, and what the crew is doing about it                  |        |
| `spawn`        | `{ name, apps?, crew?, dryRun? }`: a child forge, planned first (`dryRun` is true unless `false`); an admin's, and an `ro` token may plan but not make | yes    |
| `claim_link`   | `{ name }`: a new claim link for a child you spawned that nobody has claimed; the old one stops working. An admin's | yes    |
| `take_updates` | a fork takes its parent's updates when git can do it alone; a conflict is refused                 | yes    |
| `converge`     | the fork's crew merges where both sides changed the same files; comes back as a pull              | yes    |
| `asked`        | `{ repo?, show?, order? }`: what people asked the crew for, by default nothing merged yet and oldest first: who and when, the pulls that close it, the crew's last activity, waiting/building/shipped/closed, stale when not shipped in three days and flagged when stale with nothing built; repositories you can write |        |
| `app_members`  | `{ repo, members?, dryRun? }`: the people a private app names, who may enter it and its previews and nothing else; a writer (never an agent) changes the list with an admin-scope token | yes    |
| `explore`      | `{ query? }`: the apps and people you can see, ranked by forks, ships, use and freshness, with their numbers; `kind:` `sort:` and words in one line |        |
| `feed`         | `{ limit?, cursor? }`: your home timeline — tells, replies, runs, changes and looks — ranked, with who, what, why and a link; the same items as `GET /api/v1/feed` |        |
| `make_it_yours` | `{ repo, name?, visibility?, dryRun? }`: a fork of an app you can see, as your own app, following the original; code and history copied, data and secrets not; private unless `visibility` is public (a public original only); at most 5 copies an account a day; plans unless `dryRun` is false | yes    |
| `front_page`   | `{ pinned?, hidden?, weights?, dryRun? }`: the front page as a stranger sees it, ranked, with numbers; a site admin sets what is pinned (first public one featured), hidden, and what counts (weights of forks, ships, use, fresh, 0 to 10) | yes    |
| `map`          | an app's plan: ready now, waiting on what, the critical path, where the crew is, parked twice and why (`app`) |        |
| `milestones`   | `{ app, issue? }`: how far each thing asked for is (and, with `issue`, whether you watch it: `watching`), from the dependency tree: the plan's limbs with their weights, or one milestone opened (who is building, what is blocked and on what, what merged in 7 days, an estimate) |        |
| `limb`         | `{ app, issue, action, reason?, pillar?, operation?, dryRun? }`: defer, resume or close a whole limb as not doing, or undo an operation; plans unless `dryRun` is false, and applying takes an admin token | yes    |
| `watch`        | `{ app, issue, watch? }`: watch a milestone, or stop with `watch: false`: one item in your feed that follows it, and one push to your phone when it lands | yes    |
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

Any MCP client that can send a header works the same way.

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
