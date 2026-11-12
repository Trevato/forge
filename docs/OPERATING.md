# Operating the forge

This document is for the person who runs a forge after it has started. It covers
configuration, health, how a release proves itself, the switches and limits an
admin controls, and how checks run. Configuration is environment variables with
defaults.

To start a forge, see "Run it" in [`REFERENCE.md`](REFERENCE.md#run-it). To
respond to an attack or a leaked token, see
[`SECURITY-RUNBOOK.md`](SECURITY-RUNBOOK.md). To recover from a failure, see
[`RECOVERY.md`](RECOVERY.md).

## Configuration

Configuration is environment variables, all with defaults: `FORGE_DATA`
(`data/`; the forge refuses to boot when it is the checkout itself or a path
inside it that git does not ignore), `PORT` (`3000`), `FORGE_SSH_PORT` (`2222`; `0` turns SSH off), and
`FORGE_HOST` (`localhost`, the hostname in clone URLs). `FORGE_DRAIN_LINGER_S`
(`10`, 0 to 120) is how long a forge sent SIGTERM keeps answering while
routers learn it is going, so a roll refuses nobody (`docs/ops/ROLL.md`).
Connecting origins
adds `FORGE_URL` (the canonical public base URL, needed for OAuth callbacks),
`FORGE_GITHUB_CLIENT_ID` / `FORGE_GITHUB_CLIENT_SECRET`, and
`FORGE_ORIGIN_ALLOW` (hosts an operator vouches for on a LAN, for discovery
and for that origin's git). Behind a
platform edge that signs people in for every app it serves, `FORGE_EDGE_TOKEN`
is the edge's secret: a request carrying it and `X-Plat-User` is that person,
signed in by the platform if an account of that name exists. An unknown login
makes none: it is sent to `/signup`, where the `signup` setting decides, and
the name there is pinned to the login the edge vouched for (a visitor the edge
has not vouched for is sent through it first), so a platform user's name can
never be taken by someone else. The terminal cannot see `X-Plat-User`, so
behind an edge sign-up is on the web page only and the terminal says so. Setting
`signin.edge` to `off` (Settings → Capacity → "Sign in through the platform
edge", boot default `FORGE_SIGNIN_EDGE`, also `/api/v1/admin/capacity` and the
MCP `capacity` tool) makes the forge ignore `X-Plat-User` even when the secret
matches; people then sign in with a password or a passkey. An admin with
neither is refused, so no one locks themselves out. Accounts the edge made
cannot sign in while it is off until they add a passkey (a password-less
account cannot set a password: `/settings/password` asks for the current one). Before switching it off, see [edge-only accounts](features/edge-only-accounts.md).
To switch it off on a preview: sign in there as an admin with a password or a
passkey (Settings → Passkeys adds one), open Settings → Capacity, set "Sign in
through the platform edge" to `off`, then sign out and back in with the passkey
to prove the way in. To roll back, set the same row to `on` (or Put back, which
returns to `FORGE_SIGNIN_EDGE`, `on` when unset); with no browser,
`PUT /api/v1/admin/capacity/signin.edge` with `{"value":"on"}` and an admin
token (`POST /api/v1/tokens` with the password still mints one while it is
off). A stored value outranks `FORGE_SIGNIN_EDGE`, so changing the environment
alone does not roll back. Switching production off is the owner's to do, with
the owner present. `test/signin-edge-off.test.ts` walks this round trip.
**Dry run first.** Settings → Capacity has a "Dry run" button on that row (and
`PUT /api/v1/admin/capacity/signin.edge` with `{"dry_run":true}`): it changes
nothing, says how many accounts sign in without the edge, names each one that
would be locked out, and says so when that includes you, in which case the switch
is refused until you add a passkey. Settings → Accounts shows the same count.
With the edge off, `/_plat/login` is not linked from the sign-in page and
`X-Plat-User` is ignored; `--first-admin` is untouched, so the operator's link
still works as a break-glass. Locked out: see `docs/SECURITY-RUNBOOK.md`,
"Locked out after the edge went off".
Account settings show "open-platform.sh: linked as <login>" or "not linked": Link
records the login the request carries against the signed-in account, Unlink removes
it (same-origin POSTs). An edge sign-in finds the account by its link first, then by
name; one login links to one account, and a login that is another account's name
cannot be linked. The terminal's "What I can do" screen shows the same line and `u` unlinks (SSH carries no edge header, so linking is on the web page only).
On a forge with a parent, settings also show "<parent host>: linked" or "not linked". Link is a same-origin POST that runs the `/signin/parent` PKCE round trip for the signed-in account and, on return, writes its `federated_identity` row (never an account); an identity another account holds, or a second identity for this account, is refused. Unlink removes it. The terminal's "What I can do" shows the line and `p` unlinks; linking needs a browser.
Mail out
(the link that proves a newcomer's email) is SMTP submission over TLS,
configured by the forge-level secrets `MAIL_SMTP_URL`
(`smtps://user:pass@host:465`) and `MAIL_FROM`, set live under Settings →
Secrets, or at boot by `FORGE_SMTP_URL` / `FORGE_MAIL_FROM`. With neither, no
mail is sent and a newcomer waits for the owner to verify them. With
`FORGE_TURNSTILE_SECRET` and `FORGE_TURNSTILE_SITEKEY` set (the forge refuses to
boot with only the secret), `/signup` renders the Turnstile widget, its CSP
allows `https://challenges.cloudflare.com`, and signup asks Cloudflare's
siteverify about the posted `cf-turnstile-response` (API: `turnstile_token`),
refusing a missing or bad token before it hashes a password or makes an
account. Unset, signup is open. The terminal (SSH) cannot show a widget, so
with Turnstile on it creates no account, the forge's first neither; everyone
is told to sign up on the web page. Accounts made through the platform edge are not checked. Behind a
proxy, `FORGE_TRUSTED_PROXIES` (comma-separated CIDR ranges, e.g.
`10.42.0.0/16` for a k3s ingress) names the proxies allowed to say who the
client is; limits for strangers and the signup audit then see each outside
client, read from `X-Forwarded-For` right to left past the trusted hops, or
from `FORGE_CLIENT_IP_HEADER` when the edge sets one (`cf-connecting-ip`
behind a Cloudflare tunnel, where the ingress rewrites `X-Forwarded-For`;
read only from a listed proxy). Once set, only the listed ranges are proxies:
this machine is not one unless listed, since every app runs beside the forge.
Unset, only this machine may say so, and the named header is never read. Everything a forge
instance _is_ lives under the data directory — the SQLite index, the bare
repos, and the SSH host key, in plain layout. Tar it up and it moves.

## What the forge stands on

Each thing the forge needs to answer a request, sign a person in, build,
release and back up, the machine it runs on, what happens to the forge if
that machine dies, and the issue that removes the dependency. The list is the
steward's read-only inventory of both machines on 2026-11-12 (#11685), the day
pg-grand took the forge off the internet for 24 minutes while the forge itself
ran fine on the vxrail, and the day the owner decided to drop pg-grand
(#11686). Every row on pg-grand is a way that machine takes the forge
down.

<!-- footing:start — written by footingTable() in src/system/footing.ts; test/footing.test.ts holds it equal -->
- **pg-grand**: DigitalOcean. The k3s server, a single control plane with no HA. The owner decided on 2026-11-12 to drop it.
- **vxrail**: A k3s agent joined to pg-grand. The forge runs here.

| Needed to | Piece | Runs on | If that machine dies | Breaks | Removed by |
|---|---|---|---|---|---|
| (a) answer a request | The forge's pod (git.open-platform.sh/trevato-apps/forge:&lt;version&gt;) and its data, PVC forge-data-vxrail (60 Gi) | vxrail | The forge is down, and its data is on that disk. | — | — |
| (a) answer a request | Cloudflare tunnel carrying forge.open-platform.sh (standby/cloudflared), moved to the vxrail by hand on 2026-11-12; its last-applied manifest still says 0 replicas, so a re-render moves it back | vxrail | It goes with the forge, which runs beside it. | — | #8948, #11686 |
| (a) answer a request | The vxrail's own tunnel (standby/cloudflared-forge-home, 2 replicas): it too sends *.open-platform.sh to Traefik; only forge-home-test.open-platform.sh and arm--forge-trevato-apps.open-platform.sh go straight to the forge | vxrail | It goes with the forge, which runs beside it. | — | — |
| (a) answer a request | Traefik (kube-system/traefik): every public request goes tunnel → Traefik → the forge's Service | pg-grand | The forge is off the internet; it keeps running inside. | 1 | #11686, #8946 |
| (a) answer a request | Child and app hosts, Traefik IngressRoutes forge-children (&lt;name&gt;--forge.open-platform.sh), forge-apps (*--forge-trevato-apps.open-platform.sh) and forge-old-host, and game.cheffryjames.com and www.cheffryjames.com in the forge's namespace | pg-grand | No child forge, app or custom domain answers. | 1 | #11686, #8946 |
| (a) answer a request | forge-ssh, a host socket proxy (:2222 → the forge's ssh service) | pg-grand | git over ssh and the terminal stop answering. | 7 | #11686 |
| (a) answer a request | The k3s API server (the vxrail is an agent joined to it) | pg-grand | Running pods keep running, but nothing reschedules, Services stop updating, and no release rolls or Job runs. | 5 | #11686 |
| (b) sign a person in | Sign-in edge: a forwardAuth middleware on the forge's Ingress, answered by mcp/plat-auth | pg-grand | Every request through the edge answers 500, /healthz too. | 2 | #11686 |
| (b) sign a person in | forge-signup-gate, the pod /signup is routed to | pg-grand | No one can sign up. | 3 | #11686 |
| (c) build | Forgejo (git.open-platform.sh) and its Actions, which build the release image | pg-grand | No release image is built. | 4 | #11686, #8941 |
| (c) build | Forgejo's database, a single instance under CloudNativePG (cnpg-system) | pg-grand | Forgejo stops, and with it builds. | 4 | #11686, #8941 |
| (c) build | forgejo-runner-vxrail, a Forgejo Actions runner | vxrail | It goes with the forge, which runs beside it. | — | — |
| (d) release | Forgejo's registry (git.open-platform.sh), which the forge's image is pulled from | pg-grand | A pod that restarts on a node without the image cached cannot start; nothing new is released. | 4 | #11686, #8941, #8942 |
| (d) release | registry-node, a registry on the vxrail | vxrail | It goes with the forge, which runs beside it. | — | — |
| (d) release | forge-release-tick, a host timer every 5 min | pg-grand | Nothing is released; production keeps the release it has. | 7 | #11686, #8942 |
| (d) release | standby-reconcile, a host timer every 2 min that applies the forge's manifests from Forgejo; Flux's Kustomization for the forge is suspended | pg-grand | A changed manifest is not applied; the running pod is untouched. | 7 | #8948, #11686 |
| (d) release | Host timers forge-watchdog, forge-github-mirror and forge-prune-images | pg-grand | The watchdog, the GitHub mirror and image pruning stop. | 7 | #11686 |
| (e) back up | The backup namespace's CronJobs (FORGE_BACKUP_LANES) | pg-grand | No new backup is taken. | 6 | #11686 |
| (e) back up | MinIO, where the backup lanes store the forge's backups | pg-grand | No new backup is stored, and those it holds go with the machine. | 6 | #11686 |

If pg-grand were switched off now, the forge breaks in this order (the Breaks column):

1. Traefik: nothing public reaches the forge
2. plat-auth: no one signs in
3. the signup gate: no one signs up
4. image pulls and releases
5. the control plane: nothing reschedules, Services stop updating
6. local backups
7. the host timers

Also on pg-grand, not in the forge's path: Forgejo and its database, the platform's mcp/plat-auth and www, the CloudNativePG operator with the tenant apps' databases, their local-path volumes pinned to that node, and MinIO.
<!-- footing:end -->

The same list is read from the live cluster on `/system`, under "What the
forge stands on", on the terminal's screen of that name, and from the MCP
`system` tool with `{ kind: "footing" }`; how to read each is in
[docs/features/footing.md](features/footing.md). The probe
(`src/system/footing.ts`) asks the kube API, with the forge's own service
account, for the forge's node, the nodes labelled control-plane, and the pods
in each namespace above; it never lists every pod in the cluster. What the
cluster cannot show keeps its declared machine and says why. To see every
row from the cluster, the forge's service account needs `get` on its own pod,
`list` on `nodes`, and `list` on `pods` in those namespaces (#8948). The
reading is held 60 s, a page waits at most 0.8 s for it, and a probe that
fails is not retried for a minute.

## Health

`GET /api/v1/health` (and the MCP `health` tool) answer a site admin with
`degraded`: one entry per thing that needs a person, `{cause, sentence,
since, href}`. `cause` is a stable key (`disk`, `errors`, `internal`,
`queue:<kind>`, `stuck:<runId>`, `budget:<runId>`); `since` is when it began, by the oldest
evidence (oldest queued run, last heartbeat, oldest error or refused call in
the hour) or else the first time the forge saw it, and holds until the cause
clears; `href` is the page to look at. The board's forge strip links each
entry, and the terminal dashboard prints each with its start. When the guard
view holds something that needs a person (a held or stuck rollout, an OOM kill,
or a platform view gone stale), the board's strip and the terminal dashboard
both lead with one line, `needs you: forge <what>`, and do not repeat it as a
rollout line. A drain that runs too long is not on either; it is a push, not a
door: an admin with a notify URL is paged once when a drain passes five
minutes and once, by the draining process as it exits, when it ends. A process
that dies mid-drain says nothing more.

The same push pages the vitals causes `errors`, `internal`, `queue:*` and `disk`
once each has held five minutes, and says Recovered once it has been gone five
(a flap in between is no news). A cause present at boot is taken as already
paged. Every other cause (`drill`, `mirror`, `stuck:*`, `red:*`, `snapshots`,
`budget:*`) is paged elsewhere or is a setting, and is ignored here.

## A release proves itself

A new version proves itself once per version: after a boot that changes
`FORGE_VERSION`, the forge waits (up to 10 minutes) for its public URL to
answer `/healthz` as that version, then runs the smoke checks (`src/release/smoke.ts`) against it and
keeps the verdict in `$FORGE_APP_DATA/release/proof.json`. A failure is a
`Release X is unproven: …` card on an admin's board and on the terminal's first
screen (the same cards), and is paged once; a later passing version clears it.
A failed proof is tried again after 5 minutes, doubling to an hour; one that
failed only because an answer was slow (`slow: true` in the proof) is tried
again after a minute per failure in a row (1, 2, 3, 4 minutes), then the doubling.

**The outsider suite** (#663) is the proof a person reads before flipping signup
to open. It adds the proof only: it removes no gate and reopens nothing.
`signup-gate.yaml` and `outsider-gate.yaml` in `trevato-apps/gitops` stay up
until a person deletes them there.

It tries what a stranger must not do through all the doors a stranger has:

- **HTTP API and web form** (`src/release/outsider.ts`): an admin token, a
  repository or app of their own, any read of the owner's private
  repositories, and assigning a crew member on a real issue — the JSON
  `PUT …/issues/:n/assignee` with a token, and the form `POST
  /:owner/:name/issues/:n/assignee` with the cookie session a browser would
  hold. A refusal is positively seen: a 403 with its error code, a 404 only for
  private repositories, or a redirect whose landing page says so. The issue is
  read back and its assignee and the repository's runs must not have moved,
  and the owner's own call to the assignee route must answer 422 so a rename
  turns the suite red.
- **MCP** (same module): `tell`, `make_it_yours`, `signup`, and reads of
  private repositories through `repo`, `usage` and `apps`, each required to
  answer as an error; `tools/list` must still name them.
- **Terminal** (`test/helpers/outsider-tty.ts`, run by
  `test/outsider-tty.test.ts`): the stranger drives the terminal in process,
  asks for a new repository, searches for a private one and opens the assign
  picker on a public issue; the screen must show the refusal and nothing may
  change. The terminal is a client of the forge's actions, not of HTTP, so it
  cannot be driven against a live forge: it runs in the gate only.

`test/outsider-suite.test.ts` and `test/outsider-tty.test.ts` run in the gate
and each prove the suite goes red with a door left open.
`FORGE_TOKEN=… bun scripts/smoke.ts <url> --outsider` runs the HTTP and MCP
doors against a live forge. **It makes a real account on that forge**, so
point it only where that is wanted. Its result is valid for reopening signup
only together with a green gate run of the terminal test; HTTP and MCP green
alone do not cover the terminal door. Without `FORGE_TOKEN`, `--outsider`
exits 2 and the suite reports `owner token` as not tried, so a partial run is
never read as a pass. Spend and run bounds are proven in process only; this
pull adds the proof but does not reopen signup — the gitops gate stays for a
person.

`bun scripts/smoke.ts <url> --standards` prints the website-specification
report (`src/release/webspec.ts`, `webspec-site.ts`): it fetches each path in
forge.json's `app.looks` from `<url>` and prints one line per finding with the
specification.website section it cites. Head and header findings come per
path. Once per site it also checks the well-known files (robots.txt and the
sitemap it names, with each listed same-origin URL, at most 50, fetched
anonymously; `/.well-known/security.txt` with a future `Expires:`; the web
manifest with a name and icons; `/llms.txt`; `/.well-known/change-password`
redirecting) and the error pages (a random path must answer 404 with the app's
own HTML page). `--error-path <path>` names a path that is meant to answer 500
with the custom page; the 500 check runs only when it is named, because the
report never causes an error on its own. It only reports and always exits 0.
`(edge)` marks a finding the edge in front of the app may own (HSTS), so fix it
there rather than in the app. Each fetch gives up after 10 seconds.

`--standards` also runs axe-core (`src/release/axe.ts`) over each path in light
and dark and loads each with JavaScript off, reporting an empty `<main>` or a
missing `<h1>`; it needs `chromium` on `PATH` or `FORGE_CHROMIUM` (without one
it falls back to a regex read of the served HTML). axe-core is a devDependency
of this check only, never loaded by the server: its rules need a rendered page
and an accessibility tree, which nothing dependency-free gives.

## Secrets in the terminal

A forge admin opens the palette (`ctrl+k`), picks **Secrets**, and sees the sealed names at a place with when each was set and last read — names only, never a value. `a` sets one (place, name, then the value typed or pasted masked and kept verbatim, newlines included), `d` removes the one under the cursor after a confirm, `s` looks at another place (`forge`, `org NAME`, `repo OWNER/NAME`). Everything is `actions/secrets.ts`, as the page and MCP `secrets` use it; a member has no entry.

## Flags

A forge admin sees every declared flag at `/settings/flags` (Settings → Flags): why it exists, its default, the owner issue and its live value. Set it for the whole forge, for listed user ids or roles, or for a percentage of people; Clear returns it to the default. A change is validated, kept in the change record and live on the next request, with no restart. In the terminal the same admin opens the command palette (`ctrl+k`), picks Flags, and presses enter to set a flag from a line such as `forge=on users=u1,u2 roles=admin percent=30` or `x` to clear it; an agent is never an admin there either. The MCP `flag_set` tool does the same with the same checks, for an admin token. The page and the terminal screen both list flags through one read, `readFlags` in `src/actions/flags_view.ts`.

Settings → Usage is one page for a forge admin, opening at `/settings/spend`, with four tabs: Spend, Routes (`/settings/usage`), Capacity (`/settings/capacity`) and Telemetry (`/settings/telemetry`); each tab keeps its own URL and permission. Spend is admin-only (anyone else gets 404) and holds what the crew's runs spent, by credential, app, agent, issue and run kind; it used to sit on Subscriptions, which now links to it. Routes lists every route the router knows: its requests over the last 30 days, by role and by surface, and the hour of its last use. Routes with no request in the window are listed first, never-used ones before the longest-unused, as candidates to drop; the rest follow by count. Counts are per pattern, not per method. `usage` is also a boards source, for an admin only (an agent is refused); its `hour` column is text like `2026-10-16T13`, so group by a column such as `pattern` or `role`, not by a time bucket. In the terminal the same admin opens the command palette (`ctrl+k`), picks Usage, and reads the Routes list under a Returns line: what the crew's tokens bought over the last 7 days (dollars, runs, changes landed, the median cost of a landed change), as MCP `returns` and `/board/returns` read it; `[` and `]` move the window between 1, 7, 30 and 90 days, and a window with no runs reads "nothing spent". The palette's Usage of a repository (`owner/name`) shows that line for one app alone, as `repo` does in MCP, with no routes (they are counted forge-wide); it is for whoever may read the repository's owner facts, and anyone `returns` refuses sees no line and no window keys. The spend breakdown, capacity and telemetry tabs are web-only; an agent is never an admin there either.

Every read of a flag is counted in memory by UTC day and variant (on or off) and written in one batch every ten seconds and at exit, so a request runs no extra query. Beside each flag, Settings → Flags shows its reads per variant for the last 7 and 30 days. When one variant leads, "Make on/off the default" sets the flag to that value for everyone (user, role and percentage rules are cleared), and opens an issue on the forge's repository asking the crew to remove the losing path and the flag; if the issue cannot be opened, the flag is left as it was. The button shows only when the 30-day leader has at least 50 reads in all, the variants are not tied, and the flag's forge value is not already the leader. In the terminal the Flags screen shows the same `Uses, 7 days / 30 days` line for the flag under the cursor, and `w` does the same as the button (same admin, non-agent gate). Counts are of reads, not of people.

## Limits

Every limit the owner can hit is declared in `src/settings/limits.ts` with its default, bounds and reason, and changed live by a forge admin at `/admin/limits`, `PUT /api/v1/admin/limits/:key` or the `limits` MCP tool (never by an agent). Each change is kept with who made it.

Per-account quotas (`src/settings/quotas.ts`) — how many `repositories` and `apps` one account may own, how many `previews`, `runs` and `checks` it may have going at once — are set the same way: **Account quotas** on `/admin/limits`, `GET`/`PATCH /api/v1/admin/settings` (`{"quotas": {"repositories": 5, "apps": null}}`), `GET /api/v1/admin/quotas` and `PUT /api/v1/admin/quotas/:key` (`{"value": 5}`; a body without `value` is a 422, never a clear: send `{"value": null}` for no limit) or the `quotas` MCP tool (dry by default, admin scope, never an agent). A value is a positive whole number, or empty/`null` for no limit, which is the default; anything else is a 422. Every change is kept with who made it and listed beside the form. The `apps` limit is enforced (`src/actions/app_limit.ts`): with one set, an account owning that many apps is refused one more, unless the actor is a forge admin; with none set nothing is asked. The check and the insert are separate statements, so two concurrent creates can pass by one. The refusal reads "This account is at its limit: 3 of 3 apps. Remove one to make room." and each door answers it its own way: the API (`POST /api/v1/apps` and `POST /api/v1/repos/:owner/:name/app`) a 403 `{"error": "app_limit", "message", "limit", "count"}`; the new-app page and the app settings form a 422 with the sentence on the form; make-it-yours the same sentence as an invalid error, before the fork, so no repository is left behind. The `repositories` limit is enforced too (`src/actions/repos.ts`): with one set, an account owning that many repositories (sealed forks are not counted) is refused one more by create, fork, make-it-yours, mirror, migrate and new app, before anything is made on disk. Forge admins and agents are exempt, and creating under an organisation is not counted: the quota is per account, so only a repository the actor owns itself is asked. The refusal reads "2 of 2 repositories"; the API answers 403 `{"error": "repository_limit", "message"}`, the pages say "Not made: 2 of 2 repositories." on the form (a 422), and the terminal shows it as a toast. The check and the insert are separate statements here as well, so two concurrent creates can pass by one. The `storage` limit (megabytes, `src/core/storage.ts`) bounds the bare repositories an account owns plus its apps' data: a push, create, fork, make-it-yours, mirror, migrate or new app by a non-admin, non-agent account at the limit is refused before anything is written (the account asked is the owner the repository would belong to, an organisation included); a push is refused before git runs, as a git error over HTTP and SSH ("storage limit reached: 1.9 GB of 2 GB"), and a push that would pass it is capped inside git (`receive.maxInputSize` = the room left) so it is stopped in quarantine and the repository is as it was. Every other door answers a refusal as `storage_limit`, not `repository_limit`: the API a 403 `{"error": "storage_limit", "message"}` with the message "…storage limit: 1.9 GB of 2 GB", the pages "Not made: …" on the form (a 422), the terminal a toast. A mirror's periodic sync fetch and a migrate import mark the figure stale without walking the disk, so the next check measures again and no account can mirror past the limit unseen; the one fetch that crosses the limit is let in, the next create is refused. The figure is cached per account in memory and re-measured in the background after each push, walked on the request path only when it must be: the first look at an account waits for one walk, and so does the first check after a push, create, fork, mirror or delete changed the disk (a walk already under way is joined, not repeated). An account found at its limit is measured again before it is refused, so a deletion frees it with no restart, but at most once every 5 seconds, so retries by a locked-out client do not scan the disk. Two pushes at once can each pass. Three more limits bound what an account has going at once, each unset by default and never asked of a forge admin: `previews` (live previews), `runs` (concurrent agent runs) and `checks` (concurrent checks), counted across the account's repositories and asked before the thing starts. A preview past its limit does not start: its deploy run — the check the pull shows — fails with "not started: 1 of 1 live previews", and a sleeping preview stays asleep when woken at the limit. A run or check past its limit stays queued, with "queued, not started: 1 of 1 concurrent runs" (or "concurrent checks") in its log, and starts when one of the account's own ends; none is dropped. An admin sets the three running limits exactly like the other two: the `previews`, `runs` and `checks` fields on `/admin/limits`, or `{"quotas": {"previews": 3, "runs": 2, "checks": 1}}` to `PATCH /api/v1/admin/settings`. In the terminal the same admin opens the command palette (`ctrl+k`), picks Account quotas, and sees every key with its limit and last change; enter sets one (empty for no limit), `x` clears it, both through the same validation.

Crew teams (`src/core/teams.ts`, `src/actions/teams.ts`) — a named group of agents with a charter (what it owns, what it reviews) and a dial (a whole number from 0 to 100, its share of builder slots and budget) — start as four: design, data science, security and platform, dials at 0. A forge admin who is a person sets each team's charter, dial and members at `/settings/teams` (linked from the Crew page), with `GET /api/v1/admin/teams` and `PUT /api/v1/admin/teams/:slug` (`{"charter", "dial", "members"}`, each optional, a left-out field is kept; members are agent ids), the `teams` MCP tool (dry by default, admin scope), or **Crew teams** in the terminal palette (enter sets the dial, `c` the charter, `m` the members). **Crew agents** in the palette lists each agent's model, budget and brief line; `m`, `b`, `B` change them after a confirm, `n` creates, `d` removes (MCP `agent`'s refusal codes). The dials of all teams together may not pass 100%; an agent may be on several teams, whatever its model. A refusal carries the code `bad_dial`, `bad_charter`, `over_100` or `bad_member` and the same sentence on every door: the API a 422, the page a message on the form, the MCP tool an error (its dry run answers the refusal the real call would, not a plan), the terminal the sentence in the prompt. Who is let in differs by door: the page and its stream answer a non-admin or an agent the 404; the API answers a non-admin a 403 and an admin agent a 404; the MCP tool says `not_found` to both. Each change is kept with who made it (listed on the page) and appended as a `team.changed` event for the audit; an open `/settings/teams` follows it over `GET /settings/teams/stream` (a save from any door updates the total, the cards and the change list in place, leaving a card alone while one of its fields has focus). **Dials at work** (`src/crew/team_share.ts`): an issue belongs to the team whose slug is one of its labels (`design`, `security`, …). Dispatch orders queued agent runs so each team's share of the last day's starts follows its dial; unlabelled work takes the share the dials leave, and with every dial at 0 the queue runs oldest first as before. A planning run is told each team above zero, its dial, its charter and how many labelled issues are open, and is asked to plan and label work for every one of them. A zero-dial team's label owns nothing extra: its issues count as unlabelled, so they are not starved. Not yet: no page, terminal or MCP view shows the effective share; fairness counts every agent run started (planner and reviewer runs too), not builders only; the dial does not limit budget, and nothing but the planner's brief enforces that each team has planned work each day.

Cross-team work (`src/core/issue_teams.ts`, `src/actions/issue_teams.ts`) — an issue names up to two teams, and the pull whose body closes it (`Closes #N`) is sent to review once per named team. A writer names them on the issue page (Details → Teams), with `PUT /api/v1/repos/:owner/:name/issues/:number/teams` (`{"teams": ["design", "data-science"]}`; `GET` reads them back; a non-list is a 400, more than two or an unknown slug a 422, a mirror a 409), with the `issue_teams` MCP tool, or with `t` on an issue in the terminal — all through `nameTeams`, so the refusals and their sentences are the same. For each named team without a current verdict, a crew reviewer who is a member of it gets its own run (one reviewer on both teams gets one run, and their verdict answers both). The pull page and its Files step show each team's verdict, or that it is awaited; the terminal's pull screen shows a row per team in the Merge box (`Design: approved by quill`, `Data science: awaited`, with `(on an older head)` when the verdict is stale). A team nobody on the crew can ask is not a reason to skip review: when no named team has a reviewer here (teams start empty) the ordinary single review is sent, and when only some do, the rest wait and lapse to a person with the hour like any review. The merge gate holds on it: while a named team with a crew reviewer here has not approved the head (an approval of an older head does not count), `mergePull` refuses `team_review_required` with "Waiting on Design's review. Nothing was merged." — the API answers 409 with that sentence and the team names, the pull page's merge box disables Merge and says which team it waits on, and `m` on the terminal's pull screen says the same sentence and does not merge. A team with nobody here to ask does not hold, and the owner's break-glass lands past it.

Waits between issues (`src/actions/dependencies.ts`, docs/PLANNING.md): a writer or a crew member links one issue to wait for another on the issue page (**Depends on**), with `POST`/`DELETE /api/v1/repos/:owner/:name/issues/:n/dependencies`, with the `wait_for` MCP tool, or with `w` on an issue in the terminal. A new number is linked, and one it already waits for asks a confirm, then is unlinked. All of these go through `linkIssue` and `unlinkIssue`, so they refuse the same links in the same `dependencyWords` sentences. The terminal's issue screen shows `Waits for #12 · Holds up #20` to every reader, and each number opens that issue.

The forge setting `signup` (`src/settings/signup.ts`) is `open`, `invite` or `closed`, and `open` is what a forge with nothing stored reads as. A new forge — a fresh data directory or a spawned child — stores `invite` when it first boots; a forge that already has a stored value, or has run before without one, keeps what it had (no migration rewrites it). The seeding is done by `createApp` right after it makes the database, so a crash between those two steps would leave that forge `open`. **A new forge therefore refuses its first signup too**: make the first admin with `--first-admin` (a spawned forge's claim does it for the child), or set `FORGE_SIGNUP=open` before the first boot. A forge admin who is a person changes it live — **Signup** on `/admin/limits`, `PATCH /api/v1/admin/settings` (`{"signup":"closed"}`) or the `signup` MCP tool (dry by default, admin scope, never an agent) — with no restart; any other value is a 422. `FORGE_SIGNUP` sets it at boot, and a wrong value stops the boot with a plain message; while it stays set, every restart or deploy writes it again over a change made on the page (kept as a change by `boot`), so unset it to let the page decide. Every change is kept with who made it and when, and listed beside the form. While signup is `closed` (and `invite`, for anyone without an open invite link), `/signup` is one sentence with no form, the API and passkey signup answer 403 `signup_closed`, the terminal offers no Create account and refuses (with `invite` it asks for the token instead), and a first edge sign-in for a new name is 401. Existing accounts still sign in. A fresh forge's first account is held to the setting too; the operator's `--first-admin` link and a spawned forge's claim make the admin whatever it says.

### A cell's memory ceiling

A check, test or app cell asks for memory in `forge.json` (`check.limits.memory`, `app.limits.memory`, MiB) and gets it up to the machine's ceiling. The ceiling is `FORGE_CELL_MEMORY_MAX_MIB` when set; otherwise 75% of the pod's `/sys/fs/cgroup/memory.max`; otherwise 4096 where the host states no limit. A declaration above the ceiling is held to it, and a check's log shows (before its command runs) `warning: forge.json declares memory 8192 MiB; this machine grants at most 4096 (…)`. A cell stopped for memory says whether its limit was the ceiling, `forge.json` or the default. The warning is for checks only: an app declaring `app.limits.memory` above the ceiling is held to it without a line saying so, and the settings page does not show the cut either (#3134).

## Check tiers

`forge.json`'s `check` may declare `fast` beside `run` (the full gate; `full` names it explicitly). `bun scripts/test-shards.ts --tier fast --diff <base>..<head>` runs the tests that touch the diff (changed, named for a changed source file, or importing one within two hops), every repo-wide rule test (`RULE_TESTS`, #7138) and every test that reads the tree (`src/checks/scans.ts`, #10304), every test the times table records under 1 s, and any named by `--learned a,b`; a red only on files the pull did not change is run again on the base, and red there too it is main's and not counted (`src/checks/base_red.ts`). `src/checks/tiers.ts` decides; it adds no dependency.

To see what the fast tier would run for your own change before you push: `files=$(bun scripts/fast.ts) && bun test $files`. `bun scripts/fast.ts [--base origin/main] [--why | --null | --json]` lists, one per line on stdout and nothing else there, the test files `fastSet` picks for the files changed between the base's merge-base and the working tree (committed, uncommitted and untracked), by the same times table and `scripts/test-impact.json` as the check; `--why` adds a tab and the reason per file, `--null` ends each path with NUL (`| xargs -0 -r bun test`), `--json` prints `{full, files:[{file, why}]}`. Exit 0 lists files; exit 3 means the change reaches no test (stdout empty); exit 2 means the diff is one the map cannot bound (`package.json`, `forge.json`, a gate change that is logic…; stderr says `full tier: … changed`) or the arguments or git failed. The `&&` guard matters: `bun test $(…)` alone ignores the exit code and, with nothing listed, runs the whole suite. It reads the diff with `git` called by argument list, never a shell; `scripts/tier-input.ts` is the reading it shares with `test-shards.ts`.

**Verify after landing (#7786).** Landing is judged on lint and types; `check.verify` is the whole suite, run after. When a repository's `forge.json` declares it, the forge runs it on the default branch's newest checked commit at most every 30 minutes (`VERIFY_EVERY_MS`), only when main has moved, in a lane of its own beside the check slots: one run forge-wide at a time, so no landing and no pull's check waits for it, and a red never holds a pull (it is not a check of the `main` environment). The forge's own is `bun scripts/test-shards.ts --gate --impact --keep-going --nice`: every file runs past the first red, a file red on its own is run once more alone (green then, the log says `red once, green alone:` and it passes), the impact map is measured and kept from every file that ended green, and every `bun test` runs at the lowest CPU priority. A red that also fails alone (the runner's re-run, and for one or two tests the main check's flake re-run, `checks/flake.ts`) names the files it failed in; the first-parent commits since the last green verification are bisected, each step a run of only those files (`FORGE_CHECK_ONLY`) with the red's own command, until one commit is left (`checks/verify.ts` decides, `checks/culprit.ts` acts). A commit that is a landed pull gets one revert pull, which a person lands, as every revert; a push no pull carried gets one issue. A range over 256 commits, a red with no green before it, or a step red without naming a test is named in one issue instead. /boards' **Verified after landing** card (and the `verified` rows of `GET /api/v1/telemetry/flow` and the MCP `flow` tool) says how long each main has gone unverified, linking the run. Measured on a one-file diff, the fast tier picked by imports, then by the map the verification measures: `src/flow/held.ts` 210 of 1,694 → 24; `src/checks/verify.ts` 208 → 38; `src/checks/culprit.ts` 207 → 8.

In the forge itself: a pull's check runs `fast` when the manifest has one, in a clone holding the fork point and the head as `FORGE_CHECK_BASE` and `HEAD` (`origin/main` is not a ref there), with `FORGE_CHECK_LEARNED` naming tests earlier land attempts taught the pull (`src/checks/history.ts`, `learned.ts`). Landing (`landIfGreen`) runs `full` once on the merge with its base before merging (`src/checks/landing.ts`); red comments on the pull with the tests named, is remembered per head and base, and the files ride the pull's next fast run. The pull page's checks line shows the tier words. While a check runs, the line (page and terminal, one reader: `runningProgress`, `src/checks/progress.ts`) adds `61 of 170 files · 812 passed, 0 failed`, taken only from the shard runner's own log lines and left out when not yet known; on the page it is a live region (`GET …/pulls/:number/checks-line`) that re-asks every 5 seconds only while the check is queued or running; the same line is drawn on the studio's pull request page (`/pulls/:number`), and the terminal's pull screen re-reads on a 5-second tick while the check is queued or running. The checks line (page and terminal) also names the base tip the fast check merged with ("checked against main at abc1234"); `GET …/pulls/:number/checks` returns it as `run.baseOid`, empty for a default-branch push and for the `full` land gate. When the base has moved since that green, the page's line reads "Checked against an older main" (a clock, not a green mark) and the terminal's reads `checks: passed against an older main`. `GET /api/v1/repos/:owner/:name/pulls/:number` and the MCP `pull` tool carry `checkStale`, true only for an open, unmerged pull whose last check recorded a base that is no longer the base branch's tip. With `require_checks` on, such a stale green counts as a check still to come (`checksHold` in `src/checks/stale.ts`): the page reads "Waiting on checks" and disables **Merge pull request**, the terminal refuses `m` the same way, and the inbox's `look` ask and an autonomous repository's `review` ask wait for the re-check. The ask side works from the stale-ask sweep's last read of the base tip, so it drops after the next sweep, not the instant the base moves. `mergePull` refuses it too, so no door lands a stale green: `POST …/pulls/:number/merge` answers 409 `{"error": "checks_required"}` and the MCP `merge` tool `checks_required: …`, until a fresh check is green on the base as it is now. Only the merge queue's gated landing (`expect`) is not held, since its full gate ran on that very tree and base (`test/merge-stale-green.test.ts`).

A check's run page (`/:owner/:name/runs/:id`) opens with three rows, install, typecheck and tests, each `waiting`, `running`, `passed`, `failed`, `stopped` or `unknown`, always present so nothing shifts (`checkSteps`, `src/checks/summary.ts`). The log has no step boundaries, so they are inferred from it: the echoed `$ command` lines and the shard runner's banner (typecheck precedes it). A log longer than the 512 KB window whose tests cannot be seen reads `unknown` rather than wrong; readers who may not see the log get no rows; while the run is open the page fetches the rows again when such a line lands and when the run ends. No per-step duration is shown: the log carries no timestamps. The terminal's pull screen appends the same rows to its checks line (`install passed · typecheck passed · tests running`, `stepsLine`, `src/checks/progress.ts`), read through the same `checkSteps` and withheld from a reader who may not read the log.

Under the rows, once the tests have begun, the run page shows a progress bar of files started out of the banner's count, the passes and failures so far, the file(s) of the live shard running now, and each failure pinned with its first three lines of output (`parseTestsRow`, `src/checks/tests-row.ts`). It reads only the shard runner's lines and `bun test`'s `(fail)` markers; a figure the log does not give is left out. Batched shards (run side by side) report whole when they finish, so they name no running file. The words line and a slot for the pins are always rendered (the slot reserves height only while the run is open, and scrolls past 9em) so the log never shifts; while the run is open the bar is named "Test files started" and is indeterminate (no value) when the count is unknown, and once the run has ended an unknown count shows no bar; only the rows, the bar and the words are a live region, the pins are outside it, and a slot with pins is a focusable labelled region the refetch patches in place. The terminal's checks line appends the same: `tests 2 of 9 files started · 812 passed, 1 failed · failing: <names>` (`testsRowLine`, read in `stepsLine`, withheld from a reader who may not read the log).

Below them the run page has a per-look web-vitals table: LCP, CLS and TBT (`webvitals()`, `src/release/webvitals.ts`) each beside its good/poor thresholds and grade, a vital with no recorded entry as `n/a` (never zero), and a look run without a browser as one `skipped: no browser` line (`vitalsRows`, `src/checks/summary.ts`, as plain words; `vitalsTable`, `src/web/studio/vitals.ts`, escapes and renders them as a dense `.table` in a `.table-scroll` wrapper, so a phone scrolls it sideways). It is report-only: it has no verdict, so nothing in it can turn a check red. The terminal's checks line appends the same as `vitals home: LCP 3100 ms needs-improvement, …` (`vitalsLine`, `src/checks/progress.ts`, via `stepsLine`, withheld with the log). Both read one file beside the run's log, `runs/<id>.vitals.json` under `FORGE_DATA` (`src/checks/looks.ts`): an array of `{look, entries}` or `{look, skipped}`, validated and bounded on read (bad JSON, a file over 1 MB, or a malformed look is dropped). The looks run writes it (`startLooks`, `src/looks/service.ts`): the browser it already launches for a look (`src/looks/capture.ts`) opens on `about:blank` with a loopback DevTools port, installs a `PerformanceObserver` for `largest-contentful-paint`, `layout-shift` and `longtask` before the page's first script, navigates through the grant door, and after load reads the entries back and takes the picture over the same socket (no new process, no dependency, no Lighthouse; a type the browser lacks is an empty list). The phone and desktop looks are filed under the commit they picture (`runs/commit-<repo>-<oid>.vitals.json`, `writeCommitLooks`), so they become rows of that commit's check whenever it exists, even if it was made after the look (a run's own `runs/<id>.vitals.json` wins); with no browser they are `skipped: no browser` and the check is untouched. Until a check has a file, the table and the clause are absent.

While the default branch's own last check is red, the forge holds its pulls' checks queued rather than fail each one on the same test (`src/checks/red_main.ts`): the vitals carry one card naming the failing test and how many checks wait, and main going green releases them. A check a person asks for again runs at once, and no check is held more than 20 minutes, so the pull that fixes main can always show green.

`GET /api/v1/repos/:owner/:name/commits/:oid/check` answers the default branch's check of one full commit id, `{commit, checkedCommit, state, runId, summary, finishedAt}` with `state` `ok`, `failed`, `pending`, `superseded` (every check of it was cancelled, as when main moved on before it ran, and none will follow) or `none`, to whoever may read the repository's runs (`src/checks/commit_check.ts`). When the commit's own check is `superseded` or `none`, the newest green (or else running) check of a later main commit that contains it answers instead, and `checkedCommit` names that commit: main moving on never holds a release (#3966). It is half of the forge's release gate: the release workflow builds only once it reads `ok` for the tagged commit, and the build boots the image it made (`docs/ops/ROLL.md`, "The gate of record").

A test file the shard gate clears because it passed alone is still a failure: when the default branch's own check log says `fails only beside others: <files> (shard-mates: <files>)`, the runner opens one issue per file (at most 5 per run, the rest named in the log as not filed) or comments on the one already open. The issue is authored as the repository owner and its body says it was filed by the check runner. A pull or other branch's check files nothing.

## Fuzz and chaos

Invariants are proven by faults, not by hope. No dependencies were added.

- **Fuzz** (`test/fuzz-parsers.test.ts`, helper `test/helpers/fuzz.ts`): the
  manifest and check parsers, `contract.json`, hostnames, slugs, markdown, the
  diff reader and the API's JSON bodies take a seeded generator's cases. A
  failure prints `FUZZ_SEED` and the shrunk case; rerun with
  `FUZZ_SEED=<n> FUZZ_RUNS=<n> bun test test/fuzz-parsers.test.ts` and keep the
  case as a fixed test in `test/fuzz-found.test.ts`.
- **Chaos** (`src/chaos/`): a side instance on a fresh temporary data directory
  (it cannot name the live forge or a customer's app) takes four faults —
  SIGKILL mid-run, a dropped SQLite connection, a temp area that refuses writes
  (a stand-in for a full disk; nothing is actually filled), a delayed loopback —
  and after each asserts: no run vanished and all are in a known state, the
  database is whole and every open pull's head is in its repo, a snapshot taken
  afterwards restores, no sealed value is in any file in the clear.
  `test/chaos.test.ts` runs a small version in the gate (`CHAOS_SEED=<n>`).
- **Nightly**: `bun src/chaos/run.ts [--seed N] [--rounds N] --report` with
  `FORGE_URL`, `FORGE_TOKEN`. A broken invariant files an issue (fault, seed,
  log) and stands it under the umbrella `FORGE_CHAOS_PILLAR_ISSUE` (the
  P0 Trust issue waits for it); a quiet night comments one line on
  `FORGE_CHAOS_RECOVERY_ISSUE`. Scheduling it is the operator's: this repo
  ships the command, not a timer.

## Writing a database guard

A trigger's `RAISE(ABORT, '…')` is answered as a 403 to every caller,
anonymous ones included. Start the message with `forge: ` and write it for
anyone: that is what is shown, verbatim. Any other message is answered with
`refused` and logged in full (`refused by the database`, `reason=…`) for the
operator. (The three guards of migrations 62, 70 and 81 predate the prefix and
are known by name in `src/http/refusal.ts`.) The terminal's toasts follow the
same rule. A guard installed by hand without the prefix answers `refused`
until it is re-created with `forge: ` in front of its message.
