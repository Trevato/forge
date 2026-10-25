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
  on an app with `probe`, are a writer's.

## Tools

| tool           | does                                                                                              | writes |
| -------------- | ------------------------------------------------------------------------------------------------- | ------ |
| `apps`         | the apps you can see: live or not, where served, how each runs itself, what is working            |        |
| `new_app`      | `{ name, description?, owner?, visibility?, agent?, pick? }`: make an app from a sentence; answers `{ repo, url, issue, agent, run }` (`run` is the first run's state, or `none`) and draws the `ui://forge/app` card: name, production URL, first issue, agent, first run; refused as `POST /api/v1/apps` is (unverified, app_limit, no_such_agent, name_taken) | yes    |
| `repo`         | `{ repo }`: one repository's description, visibility, autonomy, `audience { level, sentence }` and `provenance` (where a migrated one came from, `null` when hidden), the same as `GET /api/v1/repos/:owner/:name` |        |
| `repo_settings` | `{ repo, description?, visibility? }` (admin token): change a repository's description and visibility as `PATCH /api/v1/repos/:owner/:name` does, for the same callers (a repository admin); answers `{ repo, description, visibility }`; a visibility other than public or private is `invalid` | yes    |
| `tell`         | a sentence becomes an issue, a builder is picked, a run starts on the crew's next tick            | yes    |
| `thought` | `{ id }`: where one of your thoughts went (its id comes from `tell` without a repo): the placement, and the earlier thoughts it repeats or takes back and the later ones that did the same; not yours and not there answer alike, `not_found` |  |
| `say`          | speak on an issue or a pull; a working builder hears it as its next step                          | yes    |
| `issue`        | `{ repo, number }`: one issue's title, state, closeReason, body, labels, assignee, comments (author, authorIsAgent, body, at) and blockedBy/blocks, as `GET …/issues/:number`; a sealed one you cannot see is not found |        |
| `pull`         | `{ repo, number }`: a pull's title, state, head and base, and for an open pull whether it merges into the base's current head (`mergeable`) and the paths that stop it (`conflicts`), and `check: { state, baseOid }`: the latest check's state and the base tip it was merged with (empty when it merged nothing); `mergeable` and `conflicts` are the same fields as `GET …/pulls/:number`, `check` is `state` and `run.baseOid` from `GET …/pulls/:number/checks` |        |
| `edit`         | a new title or body for an issue or a pull: its author's, or a writer's; an agent edits only what it wrote | yes    |
| `close`        | `{ repo, number, state?, reason?, into? }`: close an issue or a pull (`state` closed by default) or reopen it (`open`); the same rules and refusals as `PATCH …/issues/:number`: an agent closes only what the rules give it and reopens nothing; answers `state` and `closeReason` | yes    |
| `pulls`        | `{ repo, state?, limit? }`: a repository's pulls, newest first, one brief line each: `number`, `title`, `author`, `head`, `check` (state), `approvals`, `changesRequested`, `mergeable` (null once closed); `state` open (default) or closed, `limit` 1-50 (default 20); no bodies, no diffs | no     |
| `read_file`    | a file (utf-8, or base64 for binary) or a directory listing at a ref, as GET …/contents | no     |
| `seal`         | `{ repo, number, sealed }`: seal a security report (and the pull that fixes it) so only writers and the crew see it, or unseal it for every reader; a writer's, recorded | yes    |
| `secrets`      | `{ scope, ref?, action, name?, value? }` (forge admin): `list` the names and timestamps of the forge's sealed secrets, `set` or `remove` one; `scope` is forge, org or repo, `ref` the org or `owner/name`; a value is never read back | yes    |
| `org_teams`    | `{ org, action, team, user?, permission? }` (admin-scope token, an org owner): `create` a team (`permission` read, write or admin; read by default), `add_member` a `user`, or `remove` the team; the same as POST/DELETE `/api/v1/orgs/:org/teams` | yes    |
| `now`          | what the crew is doing right now: who, on what, since when, at what cost; a planner that declined the direction and waits for you comes first (`run: null`, its words in `says`) |        |
| `next_steps` | on a spawned forge, your first three steps and whether each is done; empty elsewhere or for anyone but its owner |  |
| `returns` | `{ repo?, days? }`: what the crew's tokens bought over the last `days` (1–90, default 7): dollars, runs, changes landed, cost per change; `repo` narrows it to one app of yours |  |
| `stop`         | stop one run by its id from `now`                                                                 | yes    |
| `health`       | how this forge is: the version and commit it runs, draining or not, the rollout and its incidents |        |
| `system`       | the machine the forge runs on, now: CPU, load, memory, disk, network, processes; a forge admin, or an agent granted `telemetry:read` |        |
| `cloud_accounts` | the forge's cloud accounts, each attached provider token with its use, verification, write permission and today's calls; a forge admin only (counted as a write so a `ro` token never lists them) | yes    |
| `cloud_account` | `{ verb, provider, name, value?, to?, allowed?, repo? }`: change a cloud account: `attach` or `rotate` a token (`value`), `verify` it, `rename` it (`to`), `remove` it, `allow_writes` (`allowed` true or false) or `audit` (`repo` owner/name); a forge admin with an admin-scope token; answers a one-line `says` | yes    |
| `audit`        | who can do what, per app, read from its contract.json in git: yes, own or no per door, and whether outsiders may direct its crew (`crewOutsiders`) |        |
| `account_verify` | `{ username }`: mark a person's email verified, as `POST …/admin/accounts/:username/verify` does; a person admin's, with an admin token | yes    |
| `outsiders`    | `{ repo, on?, dryRun? }`: whether people who cannot write may direct the crew; with `on`, planned first (`dryRun` is true unless `false`); set only by the app's admin with an admin token, never an agent | yes    |
| `origins`      | `{ action, id? }`: `list` your connected origins, `repos` the repositories one holds (`id`; `mirroredAs` says which are already here), or `sync` one now; the same as `GET /api/v1/user/origins`, `…/:id/repos` and `POST …/:id/sync`, for you only, an admin token as there; never a credential in an answer | yes    |
| `decisions_by` | `{ repo, by?, dryRun? }`: the standing rule for a repository's hand-overs (`me`, `decider`, `decider_tell`); with `by`, planned first (`dryRun` is true unless `false`); set only by the app's admin with an admin token, never an agent | yes    |
| `archive`      | `{ repo | repos, archived?, dryRun? }`: archive (true) or wake (false) a repository, by name; planned first (`dryRun` is true unless `false`); only the repository's admin with an admin token, never an agent. `repos` (at most 50) runs the fleet `archive` operation over them, answers each one's outcome and the `operation` id; `limb` with `action: "undo"`, that `operation` and any one of the repositories as `app` reverts it for a day | yes    |
| `events`       | `{ repo, limit?, cursor? }`: the repository's events, newest first, as you may see them (a webhook's URL and an app's variable names are the admins'): `{ items, next_cursor }`, `limit` 1 to 200 (default 50), `cursor` from `next_cursor` | no     |
| `reports`      | `{ repo, id?, action? }`: the waiting reports from outsiders, each `from: "outside"` (their words are unchecked); with `id` and `action` (`accept` opens it as an issue marked as from outside, `dismiss` closes it). A person who writes the repository only; needs an `rw` token | yes    |
| `trail`        | `{ repo, shown?, dryRun? }`: where a migrated repository came from (`provenance`: source, sourceUrl, parents, migratedAt) and whether it is shown; with `shown`, shows or hides the trail — planned first (`dryRun` is true unless `false`), only the repository's admin with an admin token, never an agent. Hiding keeps the record; a hidden one reads `null` to anyone but an admin | yes    |
| `branches`     | `{ repo, name?, action?, from?, kind? }`: without `name`, lists the branches; `kind: "tags"` lists the tags instead (as GET `/api/v1/repos/:owner/:name/tags` does, newest first; no `name` or `action`); with `name` and `action` (`create` from `from`, or `delete`) it does what the branches page does: the default branch is never deleted, only a writer may act | yes    |
| `migrate`      | `{ url, name?, crew? }` brings a public repository in by URL (history only; nothing reaches back) and answers `{ job, state, url }`; `{ job }` alone reads that job. Same validation, scope (`rw`) and private-address refusal as `POST /api/v1/migrate` | yes    |
| `commits`      | `{ repo, ref?, limit?, oid? }`: a branch's recent commits, newest first (`limit` 1–100, default 30; refused outside that, where REST clamps), as `GET …/commits` answers; with `oid` (4–64 hex) one commit with its diff and its check, as `GET …/commits/{oid}` and `…/check` answer |        |
| `probe`        | knock on a running app's doors as nobody, a user and an admin; the ones that disobey its contract |        |
| `following`    | where a fork stands against what it follows, and what the crew is doing about it                  |        |
| `spawn`        | `{ name, apps?, crew?, dryRun? }`: a child forge, planned first (`dryRun` is true unless `false`); an admin's, and an `ro` token may plan but not make | yes    |
| `agent`        | `{ action, username, … }`: `create` a crew agent, `update` its `model`, `brief` or `budgetUsd`, or `remove` it; an admin's, with an `admin` token, as `/api/v1/agents` | yes    |
| `claim_link`   | `{ name }`: a new claim link for a child you spawned that nobody has claimed; the old one stops working. An admin's | yes    |
| `upstream`     | `{ repo, enabled?, url?, branch?, check? }`: the repository a fork follows (an admin reads it); with `enabled` sets it, with `check: true` checks it now; setting and checking need an admin token | yes    |
| `take_updates` | a fork takes its parent's updates when git can do it alone; a conflict is refused. On a spawned forge's code repository it opens the one `forge/take-updates` pull and never moves the default branch | yes    |
| `converge`     | the fork's crew merges where both sides changed the same files; comes back as a pull              | yes    |
| `asked`        | `{ repo?, show?, order? }`: what people asked the crew for, by default nothing merged yet and oldest first: who and when, the pulls that close it, the crew's last activity, waiting/building/shipped/closed, stale when not shipped in three days and flagged when stale with nothing built; repositories you can write |        |
| `assigned`     | `{ limit? }`: the open issues and pulls assigned to you in every repository you can still read (repository, number, title, kind, state), as `GET /api/v1/user/assigned` |        |
| `app_members`  | `{ repo, members?, dryRun? }`: the people a private app names, who may enter it and its previews and nothing else; a writer (never an agent) changes the list with an admin-scope token | yes    |
| `explore`      | `{ query? }`: the apps and people you can see, ranked by forks, ships, use and freshness, with their numbers; `kind:` `sort:` and words in one line |        |
| `search`       | `{ q, kind?, repo? }`: issues, pulls, repositories and code you can read, the same results as /search; `repo` keeps to one | |
| `feed`         | `{ limit?, cursor? }`: your home timeline — tells, replies, runs, changes and looks — ranked, with who, what, why and a link; the same items as `GET /api/v1/feed` |        |
| `feed_chips` | `{ kind?, value?, hidden? }`: the feed chips you switched off, which `feed` and `asks` leave out; with `kind` (`kind` or `person`), `value` and `hidden` it switches one off or on | yes |
| `make_it_yours` | `{ repo, name?, visibility?, dryRun? }`: a fork of an app you can see, as your own app, following the original; code and history copied, data and secrets not; private unless `visibility` is public (a public original only); at most 5 copies an account a day; plans unless `dryRun` is false | yes    |
| `origin_apps`  | `{ action, id?, host?, kind?, clientId?, clientSecret? }`: `list` your OAuth apps for connecting origins, `add` one (a `host`, or `kind` github), or `remove` one by `id`; the API's rules and errors, an admin-scope token; a secret is never read back, only `hasSecret` | yes    |
| `front_page`   | `{ pinned?, hidden?, weights?, dryRun? }`: the front page as a stranger sees it, ranked, with numbers; a site admin sets what is pinned (first public one featured), hidden, and what counts (weights of forks, ships, use, fresh, 0 to 10) | yes    |
| `invites`      | `{ action, id? }`: `list` the outstanding invites (state and expiry, never a link) or `revoke` one by `id`; a person admin with an admin token, stricter than the API's list, which an `ro` token may read | yes    |
| `map`          | an app's plan: ready now, waiting on what, the critical path, where the crew is, parked twice and why (`app`); draws the `ui://forge/map` card |        |
| `milestones`   | `{ app, issue? }`: how far each thing asked for is (and, with `issue`, whether you watch it: `watching`), from the dependency tree: the plan's limbs with their weights, or one milestone opened (who is building, what is blocked and on what, what merged in 7 days, an estimate, and for an owner `spend`: dollars, changes landed ever, the costliest three issues) |        |
| `limb`         | `{ app, issue, action, reason?, pillar?, operation?, dryRun? }`: defer, resume or close a whole limb as not doing, or undo an operation; plans unless `dryRun` is false, and applying takes an admin token | yes    |
| `watch`        | `{ app, issue, watch? }`: watch a milestone, or stop with `watch: false`: one item in your feed that follows it, and one push to your phone when it lands | yes    |
| `runs`         | `{ repo, limit? }`: the repository's recent runs, newest first (id, kind, state, issue or pull number, started, ended), 1–50, default 20; read as the runs page reads them |        |
| `run_log`      | `{ repo, run, tail? }`: a run's log, or its last `tail` lines (1–2000), with the REST route's access: a hidden log or unreadable repository is not found |        |
| `review`       | `{ repo, number, verdict, reason? }`: approve a pull (`approve`) or request changes (`changes`, with a `reason`), as the page does; a writer's or the crew's, and never your own pull | yes    |
| `threads`      | `{ repo, number, anchor?, resolved? }`: a pull's review threads with their comments; with `anchor` (from the list) resolve it (`resolved` true, the default) or reopen it (false), by the API's rules: a writer or someone who commented in the thread | yes    |
| `usage`        | `{ repo, days? }`: what the crew's runs spent — tokens, cost, wall time — by subscription, agent, issue, and each account's 5-hour and weekly standing; a writer's |        |
| `labels`       | `{ repo, number, labels }`: set an issue's or a pull's labels to exactly these (`[]` clears); only labels the repository has, by a writer | yes    |
| `repo_labels`  | `{ repo, action?, name?, color?, id? }`: list (`list`, the default; a read-only token may), create (`create`, `name`, `color` six hex digits) or remove (`remove`, `id`) the repository's labels, as `GET`/`POST …/labels` and `DELETE …/labels/:id`; create and remove need an admin token and a repository admin | yes    |
| `wait_for`     | `{ app, issue, blockedBy, stop? }`: the issue waits for another, or stops with `stop: true`; the page's rules, and the answer carries the issue's URL | yes    |
| `confirm_wait`  | `{ app, issue, blocker }`: a person says `issue` may go ahead although `blocker` closed as dropped or split; the API's confirm action, so writers only and never the crew | yes    |
| `hold`         | `{ app, pull, why?, release?, dryRun? }`: hold a pull so no rule reviews or lands it, or let it go; a person who can write, never an agent; plans unless `dryRun: false` | yes    |
| `app_env`      | `{ repo, action, name?, value?, scope? }`: `list` an app's variable names and scopes, `set` one, or `unset` it, in `all` (default), `production` or `preview`; the API's rules and errors, an admin of the repository with an admin-scope token; a value is never read back | yes    |
| `email_verify` | no input: send the caller a new verification email, with the API's rate limit and errors; the answer never carries the link | yes    |
| `plan`         | `{ app, issues }`: open up to 12 linked issues, all or none (see below)                           | yes    |
| `prompts`      | `{ repo, action, kind?, token?, at?, id? }`: list, add, run or remove an app's prompt sources (Instagram), as the `…/prompts` API does; the token goes in once and is never shown; listed only for an admin-scope token, and only the repository's admin may use it | yes    |
| `account_suspend` | `{ username, suspended }`: suspend a person's account, or unsuspend it with `false`; their sessions and tokens stop at once; the API's rules (not yourself, another admin or an agent; not the only owner of an organization); an admin token | yes    |
| `account_role` | `{ username, role, usdPerMonth?, dryRun? }`: make a person a `member`, or a `guest` again, with an optional starter allowance (`usdPerMonth`, 0.01 to 10000, promoting only); planned first (`dryRun` is true unless `false`) | yes    |
| `mint_invite`  | `{ days? }`: mint a single-use invite link that expires in `days` (1–30, default 7) and is shown once; a person admin's, with an admin token | yes    |
| `signup`       | `{ mode?, dryRun? }`: who may sign up: `open` (default), `invite` (only a person with an open invite link) or `closed` (no new accounts); without `mode` it reads the setting, with `mode` it plans first (`dryRun` is true unless `false`), and applying needs an admin token | yes    |
| `access`       | `{ since?, ua?, path? }`: what outside agents tried: the redacted log of non-browser requests to public paths, newest first; `since` an ISO time (default a day, at most 14 days), `ua` part of the user agent, `path` a prefix; a forge admin's | yes    |
| `whoami_can`   | no input: your role and that role's row of the roles table, each ability yes or no                |        |

### Room for a new tool

Every session pays for `tools/list` first, so `test/mcp-size.test.ts` holds it
to a 40,000-byte ceiling and a 37,000-byte headroom (the answer an admin gets,
the largest). Measure before you push with `bun test test/mcp-size.test.ts`;
a failure names the bytes over and the longest descriptions.

- A new door is an `action` or `kind` on the tool that already owns the
  resource before it is a new tool.
- A new tool's description is one sentence.
- The ceiling is the owner's: never raise it in a feature pull.

Answers are JSON in a text block; most carry a `says` sentence short enough
to relay as it is.

## Arguments, in full

`tools/list` keeps every argument description to 60 bytes (`test/mcp-size.test.ts`
enforces it); `dryRun` reads `false to apply` on every tool that takes it. The
longer sentences:

- `dryRun`: plans unless it is `false`; anything else changes nothing. `limb` applying takes an admin token.
- `tell.from`: a path on this forge the issue links to, like `/alice/notes/pulls/3`. `tell.context`: where this was told from, for the builder.
- `spawn.reveal`, `claim_link.reveal`: put the live claim link in the answer (default false); it is a secret, only when its person reads it. `spawn.fresh`: a fresh app beside the copied ones. `spawn.followMode`: `tell-me` (default) or `take-updates`. `spawn.size`: recorded only, not enforced. `spawn.keepAccess`: stay an owner once claimed.
- `commits.ref`: branch, tag or commit; the default branch when absent. `report.page`: the http(s) address where the problem was seen. `plan.issues.pillar`: the pillar served, as `"P0"` or `"P0 Trust"`; `later: true` means no pillar and needs `why`.
- `explore.query`: words, plus `kind:app|person|forge` and `sort:score|forks|ships|use|fresh|name`.
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

## Cards, the contract and the plugins (#1116)

- **Cards.** `apps`, `new_app`, `now`, `asks`, `milestones`, `map` and `feed` name a `ui://` resource in
  `_meta.ui.resourceUri` (MCP Apps, SEP-1865): `ui://forge/app`, `run`,
  `decision`, `wave`, `map`, `feed`. The Plan card (`map`) shows one row per pillar with
  its ready, working and waiting counts, and the first five ready issues linked
  to their pages; it has no actions. `resources/list` and `resources/read` serve one small
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
- **Plugins.** `plugins/opencode` and `plugins/claude-code` register this
  server and add a `forge` command (tell, status, decide). They hold no logic.
