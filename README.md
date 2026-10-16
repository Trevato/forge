# forge

A software forge you can read in an afternoon and mold by hand.

It runs the apps it hosts, and a **crew** of agents builds them. You describe
an app in a sentence; the sentence becomes an issue, and the agent it is
assigned to works it in its own fork and opens a pull. Every push redeploys
that pull's own preview — its own URL, on its own copy of production's data —
and every deploy is the check on that pull. No agent can move the default
branch, so the only way code reaches production is a merge a person made: the
crew proposes, you decide what ships.

That view is the **studio**, and it is the front door — a browser with no
`forge_mode` cookie lands there. It speaks four words for the whole loop:
_tell_, _working_, _look_ and _shipped_; an autonomous app lands its own
green changes, and nothing waits on a person. [`docs/STUDIO.md`](docs/STUDIO.md) is the tour;
[`docs/APPS.md`](docs/APPS.md) is the contract for apps, previews and runs. The
git underneath is one click away — the switch in the top bar, or `?mode=dev` on
any URL — and it is the rest of this page.

A forge this one spawned (hosted) runs the apps it was given too: its `bakery`
answers at `bakery--<child>--<this forge's host>`, in this forge's lanes, on the
child's own data, and `/forges` says how many are running and why any is not.
In the terminal an admin's palette offers "Forges you sent": each forge with its
claim state and the same apps-running note, never a claim link.

Git hosting, code browsing, and a JSON API in one fast Bun process, with
**zero runtime dependencies** — the `package.json` dependency list is empty and
stays that way. The one exception is dev-only: `@anthropic-ai/sandbox-runtime`
(a devDependency, with its own few transitive packages) lets
`test/crew-sandbox-real.test.ts` run a shell under the very sandbox Claude Code
builds from the crew's settings; it never ships and the app never imports it. Everything worth having is written here: the Result type, the
router, the SSR templates, the design system, the markdown renderer. The only
thing forge asks of the host is a `git` binary.

Forgejo is the reference for what a forge should _feel_ like. This is that
feeling on a foundation sized for one person.

## Run it

```sh
bun install          # dev-only: types + tsc (native, 7.x), no runtime deps
bun run src/main.ts  # web on :3000, ssh on :2222 (FORGE_SSH_PORT=0 turns it off; a taken port turns it off with one warning)
bun src/main.ts --preflight  # can this tree boot? config parses, migrations run on a copy of the database; one line, exit 0 or 1, no socket opened. Run it before the swap, not under load: the copy is not atomic against a live writer, and a `preflight-*` directory a killed run left behind is swept by the next run once an hour old, and a missing data directory is created, as boot would
bun src/main.ts --rollback <sha>  # swap back to a kept release: a full 40-hex sha under $FORGE_DATA/releases/, PORT as the running forge's. Exit 0 once that release reads healthy as that sha, else 1 with one line
```

Set `FORGE_REPO=owner/name` to the forge's own code and a pull the crew lands there is written to `$FORGE_DATA/releases/<sha>/` (the newest `FORGE_RELEASES_KEEP`, default 5, are kept), preflighted with that tree's own `--preflight`, and recorded in the `release` table (sha, landed pull, verdict, its line, when). A red preflight is asked again once (the copy of the live database can tear under load); a second red is logged and told to the landed pull. Other repositories are untouched, and nothing is swapped unless `FORGE_SELF_SWAP=1`: then the forge binds its port with SO_REUSEPORT, a green release is started from `releases/<sha>/` beside it on the same port (`FORGE_COMMIT` set to the sha), `/api/v1/health` is read until an answer names that sha and is well (`FORGE_SWAP_BUDGET_S`, default 60), and only then does this process drain as a SIGTERM does — except that it stops accepting at once, so every new connection is the release's, and answers what it already holds (a long push or clone) to the end, for up to five minutes, before it closes. A release not healthy in its budget is killed, the old keeps serving, and the log and the landed pull say so. One swap per process: a landing while another swap is in its budget, or after one succeeded, is released and recorded but not started (the new process runs it from the next restart). The SSH terminal is not handed over yet (the new process cannot bind the old one's port), so a process holding the SSH listener refuses the swap and tells the landed pull; run with `FORGE_SSH_PORT=0` to swap. The swap also needs `net.ipv4.tcp_migrate_req=1` (Linux 5.14+): without it the kernel resets the connections still queued on the old listener when it closes, so a swap is refused (and told to the landed pull) rather than failing requests. The release is a child of the old process, so the swap is for a forge run directly, not under a supervisor that kills its children when the old process exits (PID 1 of a container, a systemd unit with the default `KillMode=control-group`). SO_REUSEPORT lets any process of the forge's user bind the same port and take a share of its connections, so `FORGE_SELF_SWAP=1` assumes nothing else runs as the forge's user on the host network (agents and apps are sandboxed or in cells). `--rollback <sha>` starts the kept release beside the running forge by the same health-read swap (`FORGE_SWAP_BUDGET_S` does not apply: it waits the default 60s), and a release that is not healthy is killed with the old still serving. It refuses, with one line and exit 1, a sha that is not kept (never checked out, or pruned) and a release whose schema has fewer migrations than the live database has applied (`<sha> predates schema N; rolling back would need a down-migration`); a release with a newer schema is allowed, as it migrates forward on boot, and the database's refusal of a future schema is unchanged. It does not drain the forge that was serving: until part 2 of the rollback does, both processes share the port and the operator stops the old one (the command prints that). It does not check `tcp_migrate_req` or SSH either; stopping the old process cleanly needs the same `net.ipv4.tcp_migrate_req=1` setup as the swap, and the SSH port stays with the old process. `/releases` lists the kept releases (short sha, landed pull, when, and since when the live one has been healthy: this process's start); a person who writes the `FORGE_REPO` repository (never an agent: the button is hidden and the POST is a 403) gets a Roll back button on a kept, schema-compatible release, which runs the same refusals and swap and then drains this process (so it needs `FORGE_SELF_SWAP=1`); only readers of that repository and site admins see the page and the home line (anyone else gets a 404), and the forge's SSH terminal has the same, gated the same (`src/release/gate.ts`): the palette's `Releases` shows `live: <sha> since <time>` and the kept releases, only to those readers, and Enter on a rollable release asks to confirm then runs the same rollback as the button (a person who writes the repository only, never an agent; told when `FORGE_SELF_SWAP` is off); the home carries a `live: <sha> since <time>` line linking there. `FORGE_REPO` also names the parent code that spawned child forges fork.

**Keeping a domain drill**: `POST /api/v1/drills` (a site admin person; an agent is refused with 403, and a session needs a same-origin request) takes `{domain, seen:{health, board}, backSeconds}`: a domain key from `docs/DOMAINS.md`, what the drill read from health and the board (text, at most 8000 characters each), and whole seconds until the forge was well again (0 to 31536000). The body is capped at 32000 bytes (413). It answers 201 `{id, domain, backSeconds, green, why}`: the verdict is judged against the domain's own words and kept whether green or red. An unknown domain, bad `seen` or bad `backSeconds` is 422. Kept drills are read back on **Settings → Failure domains** (below). To run a drill by hand, `FORGE_TOKEN=… bun scripts/drills/run.ts <domain> --forge <url>` (plain `http` is refused unless the host is loopback or you pass `--insecure`) prompts for the fault, watches health and the board until the forge is back, and posts this for you (`docs/DOMAINS.md`).

If your shell already has `FORGE_URL` set — a crew workspace sets it to the
forge you work for — this forge takes it as its own canonical address and
refuses every form a browser posts to `localhost`: run it with
`env -u FORGE_URL bun run src/main.ts`, or set `FORGE_URL` to wherever you
will actually browse it.

The first account you create becomes the admin — from the browser, the API, or
a terminal (`ssh -p 2222 localhost` on a fresh forge offers to create it). Then:

```sh
# mint a token, create a repo, push to it
curl -sX POST localhost:3000/api/v1/users \
  -d '{"username":"you","email":"you@forge.dev","password":"a-good-passphrase"}'

TOKEN=$(curl -sX POST localhost:3000/api/v1/tokens \
  -d '{"username":"you","password":"a-good-passphrase","name":"cli","scope":"rw"}' \
  | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

curl -sX POST localhost:3000/api/v1/repos -H "authorization: Bearer $TOKEN" \
  -d '{"name":"hello","visibility":"public"}'

git clone "http://you:$TOKEN@localhost:3000/you/hello.git"
```

The commits the forge writes for you — merges, squashes, reverts, web edits —
carry `you@users.noreply.<forge host>`, never your account email. Choosing your
real address is an opt-in under **Commit email** in `/settings` (or
`PATCH /api/v1/user` with `{"commitEmail":"account"}`); commits you push
yourself carry whatever your own git says.

### Proposal tokens

A writer of a repository can hand a child (a fork, or a project on another
forge) a credential that proposes and nothing more:

```sh
curl -sX POST localhost:3000/api/v1/repos/you/hello/proposal-tokens \
  -H "authorization: Bearer $TOKEN" \
  -d '{"child":"kid","origin":"https://kid.example.com/","childRepo":"kid/hello"}'
```

`child` is lowercase words and hyphens; `origin` an https address;
`childRepo` (optional) a fork of this repository, and deleting it deletes the
token, as does deleting the repository. The token expires in 30 days. It is
listed as `proposal:<child>` among your tokens, and revoking it there ends it.
Over HTTPS it pushes only `child/<name>/…` branches of this repository (anything
else is refused with one line) and `POST …/pulls` from one of them, with a
body of at most 64 KiB and 20 requests a minute. Every other request is a
403, decided in `src/http/proposal_gate.ts` before any handler runs. A proposed pull
runs no check and no preview until a writer approves its head or lets it run
(**Let it run here**, which is not a review; a new push waits again), and a bare push to `child/…` starts none. A pull
opened with it says "proposed by child … from …" on every tab of the pull's
page, in the terminal's pull view, and as `proposal` in the pull's JSON
(`GET …/pulls/:number`, and MCP's `pull` tool).

Minting, listing and revoking go through one action
(`src/actions/proposal_tokens.ts`) at every door, and only a writer of the
repository may; anyone else is told "no such resource here, or it is not
visible to you", as the API says it. The secret is shown once, on minting.
The repository's settings page is one more door: a writer sees their proposal
tokens one to a line (child, origin, expires, last used) with Revoke, and a
form that mints one and shows its secret once; others see no section.

- **MCP**: the `proposal_tokens` tool with `repo` and a `verb`: `mint`
  (`child`, `origin`, optionally `childRepo`), `list` (the ones you minted for
  the repository) or `revoke` (`id`).
- **Terminal**: `ctrl+k`, **Proposal tokens**, then the repository as
  `owner/name`. `n` mints (the child's name, then its https address) and shows
  the secret once on its own screen; `x` revokes the one under the cursor.

## Live in the terminal

`ssh` into the forge and you get the whole thing — repositories, code, issues,
pull requests with a real diff viewer, review comments, merges, settings,
tokens and keys — as a keyboard-driven terminal app. The same port serves git.

```sh
ssh -p 2222 localhost                        # the terminal UI
git clone ssh://localhost:2222/you/hello.git # git, same port
```

On a forge made for a client (one that was spawned, signed in by its claim
link), the home is their apps, one plain sentence each and one more saying
whether its agents are working, about to start, or waiting: no map, board or
settings until asked. `/?all=1` is the whole home, and its "Just my apps" link
comes back. The terminal's first screen opens with the same lines, from the
same query (`src/core/client-apps.ts`).

On a host that cannot hold cells or the crew's shell sandbox, a site admin
sees `Reduced protection: …` in one line, under the filter on the terminal's
first screen and in the web footer; nobody else does, and a fully protected
forge shows nothing.

What you asked for: `Ctrl+K`, then **Asked**, is `/asked` in the terminal — your
thoughts, then the issues you can write to that are not shipped, oldest first
(`j`/`k` move, `enter` gives the issue's web address, `r` refreshes). It is read
only, shows a guest nothing, and names nothing of a placement in a repository
you cannot read.

A client's forge: `Ctrl+K`, then **New forge** (any signed-in person's, as the
page is), is `/forges/new` in the terminal — name, for whom, what it is for,
apps to fork (`owner/name`, comma-separated), a fresh one-line app, model key
(hidden as typed), API base URL and budget, through the same `spawnDoor` as the
page, `POST /api/v1/forges` and the MCP `spawn`. `Ctrl+P` shows the plan and
makes nothing; `enter` on the plan spawns, and the claim link is shown once, in
a dialog, never kept.

The family across forges: `:` → Family in the terminal, `/family` on the web,
`GET /api/v1/family` and the MCP `family` tool all give the same view. The
forge that sent this one is shown to anyone; the forges it sent, only to a
site admin (docs/SPAWN.md, "The family across forges"). Each sent forge also
says how many of its apps run and names those that do not ("1 of 2 apps
running — bakery asleep").

Passkeys: Settings → Passkeys lists, adds and removes them (several per
account; `src/auth/webauthn.ts` verifies, no dependency, `none` attestation).
The sign-in page's "Sign in with a passkey" gives the same HttpOnly session a
password does. Lost your device? "Lost your device?" on the sign-in page leads
to `/recover`: give the email on your account and, if it is verified, a link
that lasts 30 minutes and works once registers a new passkey and signs you in.
The relying party is the address the browser used (or
`FORGE_URL`), so a passkey does not follow a forge to another hostname.
Sign-up is a username, an email address and a passkey (`/signup`, `src/web/pages/signup-passkey.ts`); the running server refuses a password-only sign-up on the form, `POST /api/v1/users` and the terminal (`passkeyOnlySignup`, set in `main.ts`). Accounts that already have a password still sign in. The owner claim of a spawned forge (`/claim`, `web/pages/claim.ts`) and an admin's everyday account (`web/pages/everyday.ts`) make their account with a passkey too (`web/passkey-ceremony.ts`, challenges from `POST /claim/options` and `POST /settings/everyday/options`); neither reads a password, and without JavaScript the page says a passkey needs it. A claim post with no passkey is refused and does not spend the link.

A forge with a parent (`FORGE_PARENT_URL`, or the `upstream` in a spawned
forge's `parent.json`) offers "Continue with <parent>" on `/signin`. The forge
registers itself once at the parent's `/oauth/register` (the client id is kept
in `rp_client`), sends the person through the parent's authorize page with
PKCE, and on return checks state (also bound to the browser by an HttpOnly
cookie), nonce, `iss`, `aud`, `exp` and the ES256 signature against the
parent's JWKS (`kernel/jwt.ts`; keys are cached ten minutes and an unknown
`kid` refetches them once a minute at most). The parent's `sub` — never the
username — maps to a local account made on first sight with no password
(`core/federation.ts`; `http/rp.ts` has the two routes). No dependency added.
The parent's answers are read by bytes and refused past 16 KiB (64 KiB for the
key set), and starting a sign-in is throttled like a password attempt.
An account made this way has no password, so the terminal's username-and-password
door (`s`) cannot let that person in. They add an SSH key under Settings → Keys
once signed in on the web; after that the terminal signs them straight in as
that account, as for anyone with a key.

Your SSH key is your identity. A key the forge knows signs you straight in; any
other key browses public repos as a guest and can press `s` to sign in with a
username and password — which links that key to your account, so the next
connection is instant. `j`/`k` to move, `enter` to open, `esc` to go back, `/`
to filter, `?` for the keys, `:` for the command palette, `t` for the theme.

**Milestones.** `:` → *Milestones in a repository* → `owner/name` lists a
repository's limbs in the order the crew takes ready work (`enter` opens a
limb's own limbs). A person who administers the repository presses `r` to
Raise or `l` to Lower the limb under the cursor: a preview of the new order
and of the top of the ready list first, then `enter` to apply (`esc` backs
out), then `u` to undo the last move. It is the same fleet operation the web
milestones page uses, and a move is heard by that page when it is open.
Anyone else sees the order and no keys to change it; a guest sees only what
the web shows them. Whoever may see owner facts also gets two lines under
the list for the limb under the cursor: **Cost and landed** (dollars spent,
changes landed) and its costliest three issues; a reader or guest sees none.
The web page has the same *Cost and landed* section on a milestone, and the
milestones API and MCP carry it as `spend` (`usd`, `landed`, `costliest`),
owner only.

Working on the UI itself? `bun run src/tui/main.ts --user alice` runs it over
stdio against your local data directory. That `--user` flag is a development
convenience and exists only there: over SSH, the key decides who you are and
nothing else can.

Configuration is environment variables, all with defaults: `FORGE_DATA`
(`data/`; the forge refuses to boot when it is the checkout itself or a path
inside it that git does not ignore), `PORT` (`3000`), `FORGE_SSH_PORT` (`2222`; `0` turns SSH off), and
`FORGE_HOST` (`localhost`, the hostname in clone URLs). `FORGE_DRAIN_LINGER_S`
(`10`, 0 to 120) is how long a forge sent SIGTERM keeps answering while
routers learn it is going, so a roll refuses nobody (`docs/ops/ROLL.md`).
Connecting origins
adds `FORGE_URL` (the canonical public base URL, needed for OAuth callbacks),
`FORGE_GITHUB_CLIENT_ID` / `FORGE_GITHUB_CLIENT_SECRET`, and
`FORGE_ORIGIN_ALLOW` (hosts an operator vouches for on a LAN). Behind a
platform edge that signs people in for every app it serves, `FORGE_EDGE_TOKEN`
is the edge's secret: a request carrying it and `X-Plat-User` is that person,
signed in by the platform, with an account made on first sight. Mail out
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
with Turnstile on it can create only the first account (the admin); everyone
else is told to sign up on the web page. Accounts made through the platform edge are not checked. Behind a
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

`/forges/new`, `POST /api/v1/forges` and the MCP `spawn` make a client's forge from forks of the apps you pick, plus optionally one fresh app from a one-line description (`fresh`, at most 200 characters), and end in one claim link; see `docs/SPAWN.md`.

`FORGE_PARENT_URL` names the forge this one was spawned from. It must be
`https://` with no credentials or query (the forge refuses to boot otherwise).
The parent serves `/releases.json` as `{"releases":[{"name","url"}]}`, newest
first; the child reads it with a 3 s timeout, no redirects and a 256 KB cap,
caches it under `FORGE_APP_DATA` for 10 minutes, and says "N releases behind
<parent>" on a fork's following card, in the terminal's About card (`I`), and as `parentForge`
(`{host, behind, releases, fetchedAt, down}`, null when unset) in
`GET /api/v1/repos/:owner/:name/following` and the MCP `following` tool. A
page never waits for the parent: it shows the cached copy and refreshes in the
background, and a parent that is down or answering garbage leaves a "could not
be reached" with the age of the last copy. Unset, nothing is shown. Read only:
taking a release is not done here. This forge publishes its own
`/releases.json` (the version names, each linking to that document), so any
forge can be a parent. The terminal shows the count, not the release names.

A spawned forge's own code is a fork of its parent's (`<org>/forge`, chosen
`followMode` `tell-me` or `take-updates`; recorded, not yet acted on). Its chain
to the root is at `/:owner/forge/following`, in `chain` of `GET
/api/v1/repos/:owner/forge/following` and the MCP `following` tool, and in the
terminal's **Chain** command; the owner severs it with the page's Sever,
`POST …/following/sever` or the MCP `sever` tool (nothing is deleted). Taking
updates into a conflict opens the converge issue at every door. See
`docs/SPAWN.md` and `docs/FOLLOWING.md`.

## Archive

An admin puts a repository away from **Settings → Archive**, with
`PATCH /api/v1/repos/:owner/:name {"archived":true|false}` (admins only; anyone
else gets 403), or in the terminal with `a` on the About card (`I`). The
repository page and the card then say when it was archived, and an admin gets
a Wake button or the same key to undo it. Archiving twice keeps the first date.
It does not yet block anything: clone, push and links keep working, and the
repository stays in every list.

## Health

`GET /api/v1/health` (and the MCP `health` tool) answer a site admin with
`degraded`: one entry per thing that needs a person, `{cause, sentence,
since, href}`. `cause` is a stable key (`disk`, `errors`, `internal`,
`queue:<kind>`, `stuck:<runId>`, `budget:<runId>`); `since` is when it began, by the oldest
evidence (oldest queued run, last heartbeat, oldest error or refused call in
the hour) or else the first time the forge saw it, and holds until the cause
clears; `href` is the page to look at. The board's forge strip links each
entry, and the terminal dashboard prints each with its start.

## Origins

Your forge is the index of everything you work on, wherever it actually lives.
An **origin** is a connected account on another forge — GitHub, Forgejo, Gitea.
Mirror a repository in and its issues, pulls, comments and labels come with the
git objects; anything you then do here is **written through** to the origin
first and reflected locally after it succeeds. For a mirror the origin is
truth, exactly as git is truth for a native repo.

**Resolving a conflicted pull.** When a pull conflicts with its base, a writer sees **Resolve** in the "Can't merge" box, which opens `/:owner/:name/pulls/:n/resolve`: one file at a time, each conflict block a card with the two sides named by their branch and the taps **Ours**, **Theirs**, **Both** and **Mine** (words typed in the box count as Mine), a running "2 of 3 resolved", and the merged file beneath. The choices ride in the query string until you press **Finish**, which commits them: the resolved file becomes a merge commit on the pull's branch (as you, the base as second parent, built with git plumbing — no clone, no agent), and the pull re-checks as mergeable. Finish is for writers with `rw` scope and refuses, writing nothing, when the branch or base moved since the page was drawn, when a block has no choice, when the pull has more than one conflicted file or a conflict with no text blocks, and for cross-repo or mirrored pulls. In the terminal, `v` on a conflicted pull does the same: `n`/`p` move over the blocks, `o`/`t`/`b` take ours, theirs or both, `e` opens a box for your own text, each file shows "N of M resolved" with its merged file beneath, and `f` finishes with the same refusals in words. On a conflicted pull held by an agent, the same page (and the same view in the terminal) also offers **Have the crew propose** to writers with `rw` scope: it queues one `resolve` run for that agent, on the pull's own branch, with a brief carrying both sides' commits, the conflict blocks and the tests that cover them. The agent merges the base in, commits the resolution and pushes; its report becomes the note on the pull. Until the run settles the card says it is working and refreshes itself on the run's events (in the terminal, `r` looks again and never asks), and a run that fails says why. When it lands the card shows the note, the commit the run left (kept on the run, so a later push is never called the crew's) and the files to edit by hand; once the head moves on, the card goes. The tap is refused, writing nothing, for a reader, a closed pull, a pull with no conflicts, a pull no agent holds, one the crew is already working on, and when the crew's ceiling or breaker has no room. In the terminal `c` in the conflict view is the only key that asks, with the same refusals in the same words. See docs/PULLS.md. Readers and guests get neither.

A pull from an outsider's fork on the origin is someone else's code, so its
check and preview wait. A person with write access lets that exact head run:
on the pull page, **Approve to run here**; in the terminal, `A` on the pull
("approve to run here"); over the API, `POST
/api/v1/repos/:o/:n/pulls/:n/approve-here`. It is a local record — a review
written through to, or imported from, the origin never counts — and a new push
waits for a new approval.

A pull a child forge proposed upstream waits the same way, and the writer who
minted the child's token may let it run: **Let it run here** on the pull page,
`A` in the terminal, or the same `POST …/approve-here`, which answers
`{granted: true, commitOid}`. That grant is recorded apart from reviews: it
never counts toward `require_review` or the merge gate, a new push needs a new
grant, and a proposed pull never lands on its own, even on an autonomous repo.

Connect one at **Settings → Origins** (or `A` then `o` in the terminal). Which
way in you get is a property of the forge, not a preference:

- **GitHub** — a device code. The forge shows a short code and a URL; you type
  the code on whatever device has a browser, and the forge does the polling.
  This is the flow that works over SSH with no browser on the server. Setting
  it up is three steps, once, for everyone on the forge:
  1. Create an OAuth App at <https://github.com/settings/developers>. Name it
     anything, set the homepage to your forge's URL, set the authorization
     callback URL to `https://your.forge/settings/origins/callback`, and tick
     **Enable Device Flow**.
  2. Start the forge with `FORGE_GITHUB_CLIENT_ID=<client id>`.
     `FORGE_GITHUB_CLIENT_SECRET` is optional and buys one thing:
     disconnecting revokes the grant on GitHub too.
  3. The GitHub button appears. Until it does, both surfaces print these three
     steps rather than naming an environment variable and leaving you to it.

- **Forgejo / Gitea** — authorization code with PKCE. They implement no device
  grant, and every instance needs its own OAuth application, so you paste a
  client id once per host — or the operator registers the host once for
  everyone, `FORGE_ORIGIN_CLIENT_ID=git.example=<client id>` (comma-separated
  for more), and Connect is one click. The page gives you the exact redirect
  URI to enter (`https://your.forge/settings/origins/callback`); a public
  client is fine.
  This flow needs the forge to know its own public URL, since that URL is
  registered with the other forge and a `Host` header is not evidence: set
  **`FORGE_URL`** to the canonical base URL (`FORGE_HOST` and loopback are the
  fallbacks it trusts). Until one of those is true the card says so, and the
  token path still works.
- **A pasted token** — the fallback that needs no registration anywhere. It is
  validated against the origin before it is stored, encrypted at rest, and
  never displayed again.

Both connect screens hand the job to whatever device has a browser: a **QR
code** to point a camera at, a **short link** (`https://your.forge/go/<10
characters>`, live for ten minutes and gone once used) short enough to type by
hand, and — in the terminal — `c` to put the link on _your_ clipboard through
your own terminal (OSC 52, so it works over SSH; iTerm2, Ghostty, kitty and
WezTerm honour it, Apple Terminal does not). `o` opens a browser only when the
forge's terminal is the one in front of you; over SSH it says so rather than
appearing to work.

Then pick what you want: **Repositories** on an origin lists everything the
token can see, and you mirror them one at a time. There is no "mirror
everything" — a mirror is a repository you own, and a hundred you did not
choose is not a feature.

A mirrored repo wears its origin in the header (`mirrored from owner/name @
host`), shows its last fetch and any fetch error in the About rail, and syncs
on a worker tick or on demand. Imported issues and comments show the login on
the _origin_, with that forge's mark, and link back to the canonical thread.
Merging a pull happens on the origin: the merge box says so and links there,
and the next sync brings back the merge commit it actually made. Pushes go
through too — the pre-receive hook forwards the push upstream first, so a push
the origin refuses never lands here either.

Only the person who connected an origin can write through it. Another writer
gets `origin_owner_only` rather than a comment appearing upstream under
someone else's name with someone else's token.

**Pins** are the bridge to the next section: the pin toggle on a repository
header (`p` on a row in the terminal, `P` on a repo's home) says "keep this on
my machine", and the dashboard grows an **On your machine** card listing them.
The server remembers only the choice — nothing about the state of a laptop —
and `forge sync` below is what acts on it.

**What an ask row waits for.** Every ask row carries one word, `waitingFor` (`src/core/waiting_for.ts`, computed once), and who it waits on, e.g. "ready to land · on you". The first that applies wins: `conflicts with main` (the last sweep found files stopping the pull, on its author), `ready to land` (a green change to look at and ship), `a review` (a review or a hand-over), `assigned to you` (the pull or issue is assigned to the viewer), otherwise `a decision`. It shows as a chip on each row of the home, as `waitingFor: {word, on}` in `GET /api/v1/asks` and the MCP `asks` tool, and in the terminal's On you card. A grouped row shares one word (the weightiest of its items), and the terminal's card shows its row's word.

**Muting a repository from the home**: each ask row on the home carries a "Mute owner/name" chip. A muted repository's asks leave the home, `/api/v1/asks`, the header count and the phone's pushes (the same per-user mute the On you card uses, no new table); the home says "N muted repositories still ask" with a "Listen again" button, and an app's own page still counts them.

**A wave proposal is one card.** With "plans need a nod" on, a plan the planner writes is kept as a proposal and opens nothing. It is one row in the asks list (home, `/asks`, `/api/v1/asks`, MCP `asks`, the terminal's On you card) with its title, its why and its issue titles, all escaped, and it asks the app's owner only. Three taps, each one POST that leaves you on the page you were on: **Approve** opens the issues with their links, exactly as an unheld plan would; **Redirect** takes a text box and hands your words to the planner as a new run on the direction issue; **Later** hides it until you bring it back, from the "N waves put aside" line under the asks (each with a "Bring back" button). A proposal is decided once. The same four verbs (`approve`, `redirect`, `later`, `again`) are on every door, all calling `actions/proposals.ts`: the page (`/asks/proposal/<id>/<verb>`), the API (`POST /api/v1/asks/proposal/<id>/<verb>`, a `rw` token, `{"words": …}` for redirect), the MCP tool `asks_proposal` (`id`, `verb`, `words`), and in the terminal `y` approve, `R` redirect, `l` later and `B` bring every put-aside wave back, on a wave row of the On you card.

**Chips on the feed**: kind chips switch a kind of post off: `reviews` (pulls), `decisions` (decisions and choose decks), `crew` (tells, replies, looks) and `releases`; a person chip switches one person or agent off. Saved per user, one filter (`chipHides`) behind the home feed, `/api/v1/feed`, the Asks list and the terminal's inbox, and the MCP `feed` and `asks` tools, which also take `hide_kinds` and `hide_people` to replace the saved filter for that one call (`[]` lifts it). `/live/apps` (your apps) is not feed items, so chips do not apply there. `GET /api/v1/feed/chips` answers `{kinds, people}`; `POST /api/v1/feed/chips` takes `{"kind": "kind"|"person", "value": "reviews"|"<username>", "hidden": true|false}` (scope `rw`, same-origin). In the terminal dashboard `1`–`4` switch the kind chips `h` on an On you row switches its author off (not your own) and the author's rows leave the card, and `P` brings every person back. The `feed_chips` tool reads them (no arguments, any token) and switches one (`kind`, `value`, `hidden`; an `rw` token).

**On you, in the terminal**, answers to the same mutes and one-move verbs as
the web card. Repositories you muted are hidden and counted ("2 repositories
muted"). On the On you card: `space` marks a row, `x` closes the marked rows
(or the row under the cursor) with one reason, `m` mutes their repositories,
`S` ships them, `u` undoes the latest set within its day, and `L` listens
again to every muted repository. Each goes through `applyAsksBulk`, so the
per-row access checks and refusals are the web's, shown in the toast.

**What the decider did today.** Today's card on the board carries one line,
"The decider closed N, deferred N, asked you about N": each count links to
its ledger rows (`/board?ledger=closed|deferred|asked`; any other value is
ignored, `?apps=` is kept). A deferral is the decider's own `stop`, never the
rule's. The ledger view lists up to 200 rows and says when it left some out.
In the terminal the same line sits above the dashboard, `C` (or the palette's
Decider) opens the rows, and `1`, `2`, `3` switch pile. Both are for the
repositories you own only: a reader sees nothing.

**Let the decider** answers a hand-over card (an issue the crew parked) when
you would rather not: the third tap on the card, `POST /api/v1/asks/decide`
(`{"item": "parked:<id>"}`), the MCP tool `asks_decide`, or `D` on the On you
card in the terminal. It sees only the direction text, whether you pinned or
muted the app, the day's spend against the ceiling, your last ten decisions
there and the card's own evidence; the decision ledger row carries exactly
that, with a reason and a confidence. A sure answer (70% or more) to set it
aside takes the card off your board; an unsure one, a failure, or no decider
configured leaves it with you. Undo for a day (`/api/v1/asks/decide/<id>/undo`,
`asks_undecide`, `U`). Each tap is a paid call, so one card is handed over
once in ten minutes.

**The standing rule** says who answers a repository's hand-overs without a
tap, three ways: `me` (the default: they wait for you), `decider` (the sweep
asks the decider about each parked card and its word stands, whatever its
confidence), or `decider_tell` (the decider's sure set-asides, 70% or more,
take the card off your board; the unsure ones stay with you). The tap on the
card follows the same rule. A shelved repository, one whose autonomy is `off`,
has its parked cards closed by rule with no model call whenever the rule is
not `me`, so turning the crew off on a ruled repository closes what it had
parked. The sweep spends at most five model calls a tick and never re-asks a
card already answered or undone. Only a repository admin who is a person sets
it, never an agent. Set it in the repository's settings (Autonomy → Decisions
here); over the API with `PATCH /api/v1/repos/<owner>/<name>`
`{"decisionsBy": "me" | "decider" | "decider_tell"}` (admin token; it is in the
repository JSON too); over MCP with `decisions_by` (`repo`; without `by` it
says how the rule is set, with `by` it plans unless `dryRun: false`); in the
terminal with `R` in the repository's workspace, which cycles me → decider →
decider_tell.

## On your machine

The forge holds the truth; `forge` keeps a copy of the parts you work on, the
way a music player keeps the albums you listen to — downloaded, fresh, and
yours when the network is not.

```sh
forge login forge.example.com    # a URL and a token, stored 0600 (macOS: keychain)
forge sync                       # clone what is missing, fetch the rest, report
forge status                     # the same report, without touching the network
forge                            # the local UI over your clones
```

Repos land under `~/src/<host>/<owner>/<name>` — the path is the identity, so
two forges with a `docs` repo never collide, and the filesystem is the index
(there is no local database of "your repos"; the walk finds them). `--root`
or `FORGE_ROOT` moves the library; `FORGE_URL` and `FORGE_TOKEN` override the
stored config for a script or a CI job.

```sh
forge sync --watch --interval 5m   # notify only when something CHANGED
forge sync --ff                    # fast-forward clean repos, and only those
forge pin owner/name               # ask the workbench to keep this one here
forge ls                           # what is here, and how stale
forge open owner/name --web        # the page, in a browser
```

`sync` never merges, rebases, resets or checks anything out. `--ff` is the one
exception and it fast-forwards a repo only when the tree is clean, nothing is
ahead, no rebase or merge is half-finished, and `merge-base --is-ancestor` has
proved that moving the branch cannot lose a commit. A dirty repo is reported
and left exactly as you left it.

`forge` with no arguments opens the local UI on the same runtime as the SSH
one: the library of clones, then a lazygit-shaped working-tree screen —
`space` stages, `enter` opens the hunks, `s` stages one, `c` commits, `P`
pushes, `b` branches, `l` log, `z` stashes, `?` shows every binding.

Build it once and put it on your PATH:

```sh
bun build --compile src/cli/main.ts --outfile dist/forge
```

That produces a self-contained binary (it embeds the Bun runtime, so expect
something in the 60–110 MB range; `dist/` is gitignored and binaries are never
committed). Until you build it, `bun run src/cli/main.ts …` is the same
program.

## Apps

A repository that runs. Press **New app**, give it a name and — if you like —
a sentence about what it should do. Seconds later it is serving at
`http://<name>.<your forge's host>` from a small, real app (notes in a SQLite
file), and if you named an agent, the sentence became issue #1, assigned.

- **Production is the default branch.** The only way code reaches it is that
  branch moving, and an agent cannot move it: the crew proposes through
  pulls, a person merges.
- **Every open pull gets a preview** at `<name>--<pull number>.<host>`,
  redeployed on each push and gone when the pull closes. Its data starts as
  a copy of production's — copy-on-write where the filesystem can — and
  never writes back. Merging moves code and touches no data.
- **The forge pill acts.** The pill the proxy adds to an app's pages
  (`"toolbar": false` in `forge.json` turns it off) links to a forge page,
  `/:owner/:name/toolbar?env=production|pull-N`, opened in a tab of its own: the
  pill posts nothing and reads nothing of the app's page, and every action is a
  same-origin form on the forge. Signed out, the page is where you are and Home.
  Signed in it shows the live agent run on this app or preview, linked to its
  run page (read once when the page opens; runs on work you may not see, such as
  a sealed report, are left out); *Report this page* / *Comment on this pull*,
  previewed first, then a receipt; *Tell the crew* for those who may direct it
  (the one `/:owner/:name/tell`); and *Make it yours* for everyone who cannot
  write the app. A production comment opens an issue carrying the page address;
  a preview comment goes on its pull. From a terminal or an agent the same
  actions are, in the SSH terminal, rows of the palette on a repository
  screen: *Working now* (while an agent run is live, left out when it is on work
  you may not see), *Tell the crew*, *Report a problem* (one text, an issue
  titled by its first line, through `openIssueThrough`) and *Make it yours*
  (the fork screen, for those who cannot write the repository); a pull is
  commented on from its own screen. Agents have the MCP `tell` and
  `make_it_yours` tools and the API's `POST …/issues`,
  `…/pulls/:n/comments` and `…/make-it-yours`.
- **A run has a budget** (`src/kernel/budgets.ts`): a check past `gate`
  (60 min) or a reviewer's run past `review` (10 min) is killed with
  `budget: <what> took <n> min, limit <m>`, queued again once, and failed
  the second time, which the vitals carry as a need for a day. `gate` is 60
  min because this repository's own gate takes 18–25 min alone and 45 beside
  another check; it comes down when the gate does. A check waiting in the lane
  past `laneWait` (10 min) or a run silent past `heartbeat` (3 min) turns the
  health degraded with one sentence naming the cause ("22 checks wait behind
  one lane; the oldest since 04:13; the lane runs #1212 for 31 min (limit
  60)"). The sentinel files each such breach at once, not once per tick:
  labelled P0 Trust and assigned to the sentinel, whose run the dispatcher
  queues on the assignment.
- **Every deploy is a run**, and the run is the check on the pull. Turn on
  **require checks** and a pull cannot merge until its head is green.
- **A production deploy records the merged pulls it carries**: one `git
  rev-list` of the deployed commit when the run finishes. The run page says
  "Carries #3, #5" and `GET /api/v1/repos/:owner/:name/runs/:id` has `carries`.
  In the terminal, open a repository and press `d` for its production deploys
  (each with what it carries), `enter` for the log, `r` to refresh.
- A **private** app answers only to someone the forge has vouched for
  (`canRead` on the repository, then a signed grant); a public one to anyone.
- **Every app has a terminal.** `ssh -p 2222 <name>@<forge>` runs the app's
  `tty` command from `forge.json` on a real pty over the environment's own
  data; `<name>--<pull>@<forge>` opens a preview's. The scaffold ships one.
- **A new app starts trustworthy.** The scaffold's door asks the app's
  contract before a body is read, every change and refused change is an
  audit row, the API describes itself at `/openapi.json`, `/healthz` says
  up, and the look is design tokens, light and dark, with no colour spelled
  out anywhere else ([docs/APPS.md](docs/APPS.md#what-a-new-app-starts-as)).

The repository says how it runs in `forge.json` (`run`, and optionally
`install`, `test`, `health`, `ready`); a `package.json` with a `start` script
is enough on its own. The forge hands the process `PORT`, `FORGE_APP_DATA`
(this environment's directory — keep state there), `FORGE_APP_ENV`,
`FORGE_APP_URL` and `FORGE_APP_COMMIT`, and nothing from its own
environment. Browsers resolve `*.localhost` to loopback, so a laptop forge
needs no DNS at all; elsewhere point a wildcard at it and set
`FORGE_APP_DOMAIN`.

The forge pill on an app's pages says where you are: its accessible name reads
`notes, production` or `notes, preview of pull #7`, and pressing it opens a
panel with the app, the environment, and a link home. The pull's title is shown
only to people who may read the pull. A tap outside the open panel, or Escape,
closes it. When a crew run is working on the app (production) or on the preview's
pull, the panel also says `scout is working on this` and links the run; it asks
`/__forge/crew` once as the pill loads, answers only a signed-in person who may
read the repository (and, for a run on a sealed issue, that issue), and shows
nothing when the crew is idle.

With a sentence and **Pick for me**, the sentence becomes a plan before the
page comes back: `src/crew/plan.ts` makes one non-interactive call to
`claude` — the quickest model, a fixed JSON shape, at most 3 seconds — for a
short checklist and a crew pick, so issue #1 opens as a checklist already
assigned to whoever the plan named, instead of a paragraph and a dropdown.
It costs one small model call per app made this way (a few tenths of a
cent), never blocks the repository or the app starting, and a bad or slow
answer is the same as none: no pick, no checklist, exactly what naming an
agent yourself already does. `FORGE_APP_PLAN=0` turns it off; so does having
no `claude` on `PATH` — either way **Pick for me** stops being offered and
`New app` behaves exactly as it did before this existed.

## The crew

In a preview (`FORGE_APP_ENV=preview`, which the platform sets) the crew is
off: no autonomy tick, no dispatch, no spend; checks still run and everything
can still be read. The boot log and the studio's crew card say so. Set
`FORGE_CREW_IN_PREVIEW=1` to run it anyway.

**Tell the crew from any page.** In a repository you may direct, the web palette
(`:` in the browser) has a *Tell the crew* row. With the script it opens the thread's own
comment box over the page you are on, without leaving it: `enter` sends (shift+
enter is a new line), `esc` closes. The tell remembers that page (`from`), and
the answer comes back to it. Without a script the row is a link to a page of
its own, `/:owner/:name/tell?from=/path`, which is the same box; `from` must be
a path on this forge. Who may not direct the crew gets a 404 there and no row.
The terminal's palette has the row too, on a repository screen, for the
same people: it takes one line, tells with no `from`, and answers in the
same words.

**The crew's answers.** On an app's page the owner's own tells show under the tell
box, newest first, each with what the crew said back (its last comment, else its
last finished run's summary, else that it is working or waiting). The region
updates live from `GET /:owner/:name/app/answers` (owner only; 404 for anyone
else). In the terminal, `a` in the repository screen opens *Your tells* with the
same rows behind the same gate.

An **agent** is an account of kind `agent`: no password, no session, and it
acts only through a token the forge mints for a run and destroys after it.
An admin creates one (**Settings → Crew**, or `POST /api/v1/agents`) with a
model, a brief in its own voice and a spend budget; a repository admin puts it
on the repository's **crew**, which is the one grant an agent can hold — it
reads and writes that repository and administers nothing.

Assign an issue to an agent and it starts: the forge clones the repository,
puts the agent on a branch named after the issue, and runs Claude Code
headless with a brief that says who it is, what the task is, how to finish,
and what will be refused. The pull opens at the agent's first push, marked
"In progress" with a link to the run's log, and its preview follows each later
push (`src/crew/early.ts`). When the agent stops, the forge pushes what it
committed and fills in that same pull (the agent's last message is the
description). A run that ends without reporting leaves the pull saying so, with
the log link; a run that is only paused (a limit, an outage) keeps saying "In
progress". A run that declines after its pull opened closes that pull with the
decline sentence and the run link, unless a person has commented on or reviewed
it: then it stays open with a comment. An agent may withdraw (close) a pull it
wrote itself, and nothing else. A body a person has edited is left alone, unless they kept its first
words ("In progress:" or "The run ended"); change those words too. Leave
feedback on the pull — a comment, a request for changes, a line comment — and
the agent picks it up in the background, resuming its session. A failed check re-engages it too, a bounded number of
times before a person must speak.

**Three rounds, then a person.** When the crew reviewer has asked for
changes three times on one pull with no approval and no word from a person
who may direct the crew between, no more feedback runs start on it. The
thread keeps a note ("Handed to a person by the crew:") with the three
asks, and the pull becomes a **hand-over** card in asks: *Tell them what to
try*, or *Close it*. Rounds are counted from the reviews, not the runs, so a
restart never adds one. A person resets the count by commenting as a
director (the crew then resumes) or by approving the pull from its page; the
card ends when the pull is approved, closed or merged. Hand-overs can be
closed in bulk like the other pull asks. The terminal's On you card lists
them as "handed over" rows: `enter` opens the pull, `x` closes it.

**A request for changes always moves.** Every tick, a crew pull whose
reviewer last asked for changes is moved on. If the builder has pushed since
and the new head is green, the reviewer is asked again: a verdict on old
code never blocks. If the verdict is on the current head and no run is in
flight, one feedback run is queued to the pull's builder, and a builder is
assigned when the pull has none. That run takes a builder slot like any
other. The tick log names each pull it moved, or why it did not, and
`/flow`, the terminal's Flow dialog and the MCP `flow` tool list the pulls
waiting on a builder and those waiting on a reviewer, oldest first.

**Already done.** A builder that finds its issue already built on the base
branch declines with `DECLINED: already done on main in <commit>`, naming the
full or abbreviated id of each commit that did it (at most five). The forge
checks that every commit named is on the base branch; only then is the run
an "already done" outcome, with no strike and nothing parked. The issue stays
open with a note naming the commits, the asked list and the issue page say
"Done on main", and the person who asked closes it (the page's Close button,
or `x` on the issue in the terminal); the close writes "Closed: already done
on main in …" on the thread. A claim with no commit, or with one that is not
on the base, is an ordinary decline and is parked as one.

**A red pull.** The decider stops a red check only when it is at least 70%
sure; below that the pull gets another feedback run. A stop parks the pull: it
closes as *parked*, not done, with a comment that says why. The pull page's
badge reads "Parked" instead of "Closed", the terminal's merge box says "Parked
by the crew, not merged", and the lists note it as stopped. Reopening it clears
the mark. Only the crew parks: the API and the page refuse `reason: "parked"`.
In the database the pull's `close_reason` stays NULL (its CHECK predates the
word) and `issue.parked = 1` carries it, so raw SQL never reads it as done.

**The merge queue.** A green, approved pull in an autonomous repository joins
its repository's queue (`src/checks/queue.ts`). The queue builds one
candidate: main, then each queued pull's squash on top of the one before, in
queue order, leaving out any pull that conflicts or has nothing left to land.
The full gate runs once on that candidate. Green lands every pull in order,
and each landing is refused unless main is still where the candidate was
built and the squash writes the tree that was gated, so main ends at the
gated tree. Red bisects: the front half is gated by itself, a green half
lands, and the red pull is handed back with the failing tests named. Pulls
that turn green while a candidate is gating wait for the next one. Each
queue's numbers — how many pulls are queued, how many are gating, and how
many landed in the last hour — show in three places: the /flow page, the
terminal's Flow command, and the MCP `flow` tool's `queue` field.

An autonomous app's planner is **held** while nothing is landing or the plate
is full: no pull has merged in 48 h while one was closed unmerged, or more than
`slots × 3` ready, unassigned issues are waiting. The tick log says which
(`planner: held`), and the board and the terminal's repository list say it in
words. A comment on the direction issue from someone who may write there lifts
the hold; an issue handed to the planner is still owed its pass.

Every tick says why each ready issue a builder cannot start is held, counted
under the first filter that holds it (`crew/held.ts`): `held: running=1
open_pull=10 stalled=12 run_cap=11` — a run on it, an open pull proposing it,
the planner's, stalled, at its run cap, parked twice, covered by a red-main
fix, or a setting's finding. `/flow` draws the same per autonomous app as one
bar, and the terminal's Flow command prints it as a line per app
(`flow/held.ts`, kept 5 s). When nothing is startable while builder slots are free and some of the
held are stalled, capped or parked twice, the planner is owed one pass with
that breakdown in its brief, to re-plan them into smaller, fresh issues; a
full plate and its own unanswered decline do not hold that pass, and the
same breakdown does not ask it twice.

The forge asks the host for one more binary: `claude`, on `PATH` or at
`FORGE_CLAUDE`, authenticated as the operator (an `ANTHROPIC_API_KEY` in the
forge's environment is handed to runs; the machine's own Claude Code login
works when there is none). `FORGE_CREW_CONCURRENCY` (2) and
`FORGE_CREW_BUDGET_USD` (5) bound it; `FORGE_CREW_CEILING_USD` caps what the
crew may spend across every repository in a UTC day, whatever each
repository's own ceiling says; `FORGE_APPS=0` turns apps and crew off. A preview whose pull nobody has
pushed to or commented on for `FORGE_PREVIEW_IDLE_DAYS` (default 3; `0` keeps
every preview warm) is stopped and reads as asleep, and asking for it wakes it.
An admin with more than one Claude account keeps them under Settings →
Subscriptions, sealed, and grants each to a repository (Settings → Crew) or
an organization (its page), down to one crew member: a work plan pays for
the work repositories and nothing else. Two on one grant take turns, and
one the provider rests hands its runs to the other until the reset.
**Model budget.** A new account has none: its repositories' crew does not run, spends nothing, and says "This repository has no model account". A person adds their own subscription at Settings → Model (or the terminal's **Model budget** command, `a`); it is sealed, granted to their own repositories only, and one per account. A forge admin who is a person gives an account a capped grant, in dollars a month spent on the forge's own credential, from the account's page, the terminal's **Model grant** command, `POST /api/v1/admin/accounts/:name/model-grant` (`{"usdPerMonth": 20}`, `null` takes it back) or the MCP `model_grant` tool; each change is in the audit. The cap is the UTC month's spend in the usage ledger, checked when a run starts and on every spend tick: a run past it stops, and its page says the grant is spent. Two runs that start together each begin with the whole remainder; the tick check ends both once the sum crosses the cap, so the overshoot is at most what they spend between ticks.

**Spend ceilings.** Apart from the grant, a forge admin who is a person may set any account's — a person's, an agent's or an organization's — daily (UTC) and per-run ceilings in dollars: on the account's page (`/settings/accounts/<name>`, an organization's too, by that address; an agent and an admin's own account have no such page), the terminal's **Model ceiling** command, `POST /api/v1/admin/accounts/:name/ceiling` (`{"dailyUsd": 20, "perRunUsd": 5}`) or the MCP `model_ceiling` tool; each change is in the audit. Both empty on the page, `none` in the terminal (its prompt shows the current ceilings, and an empty answer changes nothing), or `null` for both on the API and MCP takes them back. An organization's page is linked from its own page for an admin. An account has no ceiling until one is set, so this forge's own crew is never stopped by a default nobody chose. A run on an account with a ceiling does not start when the day's is spent or the per-run one is too small, is capped at the smaller of the per-run ceiling and what is left of the day, and stops mid-run when the day's is spent.
**Sandbox.** An agent's shell is held to a policy — the network is the forge
and the package registry, writes stay in the clone, the forge's data and the
operator's credentials are unreadable — by bubblewrap and socat on Linux
(both are in the image). Inside it a builder can install the declared
packages, type-check, and run the tests that boot a server: no unix socket is
let through, so the run carries `FORGE_TEST_SOCKET=port` and the forge listens
on a loopback port instead (`bun scripts/sandbox-probe.ts` prints each
verdict). A host that forbids unprivileged user namespaces
(many container platforms' seccomp profiles) cannot hold it, and the policy is
then switched off rather than faked. To tell which a deployment is in: the
boot log carries `agent sandbox not available here` with the reason, Settings →
Crew shows **Unsandboxed** with it, and every agent run's page says
"Sandboxed" or "Unsandboxed" from what it was actually started with (runs
from before this record say nothing).

`docs/APPS.md` is the contract: the vocabulary, and the rules that are
mechanical rather than advisory.

`docs/FLOW.md` is where every issue stands: `GET /api/v1/repos/:owner/:name/flow` returns each open issue's stage, since, stalled and unblock, plus what went live in the last 24 h.
Where the whole forge waits is a forge admin's: `/flow` shows each stage from ready to live with what waits, the oldest wait and its capacity, under one sentence naming the bottleneck, and beside each what it let out in the last hour with a 24-hour sparkline, under a line of landings and the median ask→live — every count links to the items it counts. A stalled step is a card on the home (Studio mode) for anyone who can write to the repository: an open pull whose check was never asked for, or is red, past its stage's allowance, with its stage, how long it has been stuck, and one button — Run check or Re-run — that asks for a check at the head and returns to the home. The terminal's **Stalled steps** command (palette) lists the same steps, live, and Enter or `r` does the same re-run; both read `flow/stalled.ts` and act through `flow/unblock.ts`, and neither shows anything to someone who cannot write. A conflicted pull never sits: every tick the crew's open pulls that no longer merge get one bring-up-to-date run each (one in flight per pull); after 2 failed tries in the same conflict, or 24 h since the first, the pull is closed with the conflicting files named and its issue goes back to ready, unassigned, with no strike against the builder. Conflicted pulls are listed oldest first on `/flow`. The terminal's Flow command and the MCP `flow` tool read the same: the sentence, the landings line, and each stage's count out in the last hour and in 24 h.

`/resilience` is a forge admin's too (a guest is sent to sign in, anyone else gets 404): each protection in `docs/THREATS.md` as one line, green, red, untested or "no test yet", judged by the test file it cites in the last full gate of the forge's own repository (`FORGE_REPO`; other repositories' gates never touch it). The terminal's **Resilience** command (palette, admins) lists the same lines.

The terminal also has an Access command (`:` → Access), a site admin's: it reads the same last-day non-browser requests as Settings → Access and the `access` MCP tool, newest first, and filters them with `s` (since), `u` (user agent) and `p` (path), `c` to clear.

`/system` is the machine, for the owner (#1789): per-core CPU, hwmon temperatures, load, memory, disk per mount, network, and every process grouped by what the forge launched it for (`check:<run>`, `app:<slug>/<env>`, the forge, the host) with CPU, memory and age. It reads `/proc` and `/sys` when asked (the page re-asks every 2 s; there is no timer, so it costs nothing unwatched) and its history is the `machine` board source. A test file running in more than one check at once is counted at the top of `/system` and `/flow`, with the checks. Command lines are never kept — only `*.test.ts` arguments.
In the terminal, `:` → System shows the same view (the owner's only), and `:` → Telemetry lists the agents and flips `telemetry:read` for the one you press Enter on.
An agent the owner grants `telemetry:read` (Settings → Telemetry, one switch per agent, revoked the same way) reads the same through `GET /api/v1/telemetry/{system,flow,sources,history}` and the MCP `flow` and `system` tools; private repositories' checks and apps are renamed `check:private-N` and lose their processes and test files, and `flow` (like `system`, an admin agent account needs the grant too: only a person who is an admin reads without it) names only public repositories' conflicted pulls, every read is listed on that page, and an agent without the grant is refused. `/contribute`, `GET /api/v1/contribute` and the MCP `contribute` tool are open to anyone: what the forge is, the bottleneck now, open issues labelled “help wanted” in public repositories, and how to propose (fork, pull, the same gate). The grant is a table, not a token scope, so no token has to be re-issued.

`docs/PLANNING.md` is how issues depend on issues: the edge, the map, and
what "ready now" means to a person and to the crew. The map also shows each
pillar's ask-to-live: the median hours from an issue opening to its change live
in production, over the last 7 days (also in the map and milestones API and MCP).
It reads the `deploy_pull` record a production deploy writes when it finishes,
so a page view runs no git; an issue closed by several pulls counts once, at
its first time live. On boot the forge records what the last 7 days of earlier
production deploys carried, so work that went live before the record is counted.

`docs/STUDIO.md` is the front door from the top of this page in full: the five
words and where each is decided, the box, the three lists, a tell, a run
and a change each on its own page, and the board.

`docs/CONTRACT.md` is who may do what, as a table: an app's `contract.json`,
the one evaluator every app decides with, the audit that reads it from git,
the probe that knocks on the running app, and the wall a person alone
crosses.

`docs/FOLLOWING.md` is a fork that keeps up with its parent: where it
stands, taking updates, and the crew's part when both sides moved.

`docs/FLEET.md` is one change across many repositories, runs or issues: a
query, a dry-run plan of every row before → after, a receipt, and undo.

`docs/MCP.md` is the forge as a connector, and `docs/STANDARDS.md` is what
it answers by default: `.well-known`, feeds, cards, the manifest.

`docs/SNAPSHOT.md` is a forge back from a copy: what a nightly snapshot
holds, where it goes, and the one command that restores it.

A snapshot uploads eight objects at a time. Run logs older than a day go up
bundled per day (cut at 4 MB, so a long history is several objects, never one
huge one); restore unpacks them. While one runs, progress shows on
**Settings → Backups** and as a line in the log every 500 objects or minute.
The terminal has no backups view, so it has no readout.

**Run a drill** on the same page (admins only) restores the newest snapshot
into scratch, opens it, counts what is there and unseals a value; the page
waits for it, up to 10 minutes, and the last drill shows there as one line.
Only one runs at a time. See `docs/SNAPSHOT.md`.

The forge also runs one itself every Sunday 09:00 UTC (a forge that was down
then runs it five minutes after waking, once). Each snapshot's manifest keeps
the five counts of its database; a restore that counts differently is red at
`count` and, like any red drill, one board line and one push. Snapshots from
before the counts were kept are not compared.

**Failure domains** (`/settings/resilience`, not `/resilience`, which is the THREATS.md page; admins only; a non-admin gets the same
404 as the other admin settings pages): one row per failure domain from
`docs/DOMAINS.md` — what breaks, the words the forge says, and the domain's
last kept drill (when, green or red with its reason, seconds until back) or
the sentence on why it is not drilled. In the terminal it is the **Failure domains**
command (`ctrl+k`; the **Resilience** command is the THREATS.md one), shown to an admin only and read through the same
`listResilience` action. Only the latest drill per domain is shown.
The **Owner's needs** command (admin only, `ownerView`) is the owner's one screen: the forge's needs as the board strip says them, where snapshots go (and any mirror) with the newest snapshot, and every domain with what the owner does.

A red drill, or none in eight days, is one line for the forge's admin on the
board's forge strip, in the terminal's dashboard (same `forgeNeeds`), and in
MCP `health` and `asks`; it names the failed step and the next green drill
clears it. An admin with a phone URL gets one push per cause (a new red
drill, or the silence), also when eight days pass with no event: the notifier
wakes every 10 minutes for it. The time the forge first owed a drill is kept
at boot in `drill/first-seen`; if the disk will not take it, a warning is
logged and a forge with no drill ever is not flagged.

Snapshots written to a directory on the forge's own volume, with no off-box
mirror set, are lost with that volume. That is one line for the forge's admin,
"Snapshots are kept on the forge's own volume and mirrored nowhere: losing the
volume loses them too.", on the board's forge strip (linking Settings →
Backups), in the terminal's dashboard (same `forgeNeeds`), in the asks, in
`GET /api/v1/health` and MCP `health`. Anyone else sees nothing. It clears when
the destination moves to another volume or a bucket, or a mirror is set. Every
one of those reads the vitals through `forgeVitals` in `src/actions/health.ts`.

`docs/EXTRACT.md` is the forge on a machine of its own, and the platform it
grew up in switched off: what a host owes it, the moves in order, and what is
given up.

### The sentinel

The forge hunts its own faults (`docs/CREW.md`): a hunt an hour on the
autonomy clock, sooner when a held slot or a setting left away from its
default is new. Each finding is one issue with its evidence, filed in
`FORGE_SENTINEL_REPO` (default `trevato/forge`) as the `sentinel` agent, else
the first admin. Evidence is scrubbed of anything credential-shaped before it
is filed.

A setting kept on purpose is a decision, not drift. Closing a `setting:<key>`
finding's issue, or commenting on it (a person, not the filer and not an agent), records the value
and its `updated_at` in `sentinel_kept`; while both match, the sentinel files
nothing and comments nothing for that key. Changing the value on the capacity
page ends the keeping, and the setting is reported again under the usual
one-day rule. The rule is mechanical: any close counts, with or without a
reason, so a bare close silences the setting until its value changes. Other
findings (`held`, `ledger`, `red`) are filed anew when they return.

A setting finding is the site admin's ask, never a crew run: it is not
assigned, and the autonomy clock leaves it out of the crew's ready list (`crew/setting_finding.ts`). It shows on the home (kind `setting`,
one card per key: the value, its default, who set it and when) and in the
terminal's On you card, with two answers — **Keep** and **Put back**. On the
web they are `POST /asks/setting` (`key`, `answer=keep|put`, same-origin only);
in the terminal, `K` keeps and `B` puts back the row under the cursor. Only a
signed-in site admin can answer, whatever they can write: anyone else, and any
agent, gets `not_found`/`unauthorized` and nothing changes. Keep closes the
finding and records the value in `sentinel_kept`; Put back goes through the
capacity page's own door (`changeCapacity`: same validation, record, event and
reversal). The close is the gate: Put back changes the setting, and Keep records
the value, only after a finding has closed. If none can (every one is on a
mirrored repository, or the close is refused), nothing changes and the page and
the terminal say so (`unclosable`). Only a person's close keeps a setting.

- **Board:** a site admin's forge strip shows the open findings and the last
  hunt; a guest or member sees nothing.
- **Terminal:** press `ctrl+k`, run **Sentinel** — the same line as a toast.
  Offered to site admins only.

### Passports

A crew run's environment carries `FORGE_PASSPORT`, a 15-minute credential
scoped to `health:read` for the forge alone (`src/kernel/passport.ts`, no
dependency: Node crypto's HMAC and HKDF). It opens one route and nothing else:

    curl -H "authorization: Passport $FORGE_PASSPORT" "$FORGE_URL/api/v1/passport/health"

Missing, expired, wrong-audience, wrong-scope or forged passports get a 401. A
passport has exactly one valid encoding (padded or altered variants are refused).

This route proves the mechanism and is not a privilege: it returns what the
anonymous `GET /api/v1/health` already returns. The next edge should guard
something only a passport may reach.

## Cloud accounts

**Settings → Cloud accounts** (admins) holds provider keys — Cloudflare,
DigitalOcean, AWS, Azure, Fly, Backblaze, GitHub, Vercel — sealed and write-only. Pasting one
makes the forge check it with read-only calls (listed in the header of
`src/cloud/providers.ts`) and say what it can see; a key the provider rejects
is not stored. It is sealed at forge scope as `CLOUD_<PROVIDER>_<NAME>` (secret
names are capitals, so `cloudflare/main` is `CLOUD_CLOUDFLARE_MAIN`). The page
lists names, the last check, and which run last opened each key; "Every read"
lists each open, and a run's page lists the secrets it held. A run gets a key
by declaring it like any secret. **Write allowed** is off by default: a run
that adds `writes: yes` to its front-matter and declares a cloud key whose
switch is off fails with that reason. The switch gates the forge's hand-out,
not the key — a provider key that can write still can, so paste read-only keys.
**Audit** reads one account and opens one `[audit]` issue per finding (unattached
volumes, powered-off droplets, unassociated IPs, never-active zones) with a
monthly saving estimate, skipping findings already open. It runs in the forge,
not as a crew run; AWS audits look at us-east-1 only; over-provisioned
droplets and forgotten DNS records need metrics or resolution and are not
attempted; Backblaze, GitHub and Vercel audits find nothing yet. No dependency was added.

Each account can be **rotated** (the new value is checked, then replaces the
old) and **renamed** (re-sealed under the new name, write switch kept). Each
says in one line what it is used for now — the `cloud.json` declarations on
the default branch of the first 100 repositories the admin can see, cached a minute — and
carries a "bring it home" note (`HOME` in `src/cloud/declared.ts`). Every
vendor request goes through `src/cloud/gate.ts`: an admin's verify or audit is
audited as the operator; a hand-out of a key to a run is allowed only if that
repository's `cloud.json` declares the key's vendor (`VENDOR_OF`: the provider's name, but AWS and Backblaze are `s3`), and an undeclared one is
refused before the key is opened. One `cloud_audit` row per request (account,
purpose, host and path, bytes out, when, allowed or refused — no token, no
query) is listed at **Settings → Cloud accounts → Every vendor call today**.
Rows are pruned past 90 days on every write; `at` is indexed. Left out: one
token per vendor is not enforced (several names per vendor stay allowed), and
an agent's own vendor calls beyond the hand-out are not metered. A forge admin reaches the same accounts in the terminal (`:` → Cloud accounts: each account with what it is used for, verified / last used and today's vendor calls; `a` attach, `v` verify, `r` rotate, `n` rename, `x` remove, `w` flip the write switch, `A` audit into an `owner/repo`, `c` every vendor call today (purpose, host and path, bytes out, allowed or refused), the token typed masked) and over MCP (`cloud_accounts` lists them with today's audit rows; `cloud_account` with `verb` attach, verify, rotate, rename, remove, `allow_writes` (with `allowed`) or `audit` (with `repo`) needs an admin-scope token). Both call `actions/cloud.ts`, neither ever shows a token, and anyone else is refused. A rename is refused when the account or the secret `CLOUD_<PROVIDER>_<NAME>` already exists.

## Share to the forge

Install the forge to your home screen, then Share a link or text to it from
any app: the home composer opens with it as a draft, and it is only sent when
you tap Post. Signed out, you sign in (or up) first and land on the same
draft. The share target is the web manifest's `share_target`, which only an
**installed PWA on Android and Chrome** offers; iOS Safari does not.

The home composer's app picker also has **the forge**: that sends no tell to
an app, it keeps what you typed as a thought, exactly as typed (works with no
apps too). Your thoughts from the last day stand at the top of the feed as
your own posts, marked "Received". The terminal has no feed or composer, so
thoughts are web-only there; `POST /api/v1/thoughts` is the other way in.
Within minutes the planner places each thought on the map and answers under it
in the feed, saying where it went; the MCP `thought` tool returns that
placement to the thought's author.
A thought that says an earlier one again does not open a duplicate: it links to
the earlier thought (`repeats`), comments on the issue it placed and raises it
to the front of the ready order, unless that issue is deferred or closed, which
the reply says. A close restatement counts only when the planner reads it as
plain work and nothing in it negates or flips the earlier one; "don't make X"
after "make X" is a reversal, never a repeat. A reversal links the thoughts it
takes back (`supersedes`). `/asked` shows "said again, first on …", "takes back
…" and "superseded by …" under each thought, and the MCP `thought` tool returns
`repeats`, `supersedes`, `repeatedBy` and `supersededBy` thought ids.

## Link-preview cards

`/og/repo/owner~name.svg`, `/og/app/slug.svg`, `/og/issue/owner~name~N.svg`,
`/og/pull/owner~name~N.svg` and `/og/run/owner~name~runid.svg` are 1200×630
social cards. They show only what an anonymous reader can open; anything
private, sealed or unknown is the same 404.

An app card carries the app's latest look (the production thumb, or a desktop
or phone shot taken as nobody) beside the words; a pull card carries the
production look as "before" and the pull's preview look as "after" (the
preview alone if production has none, nothing if the pull has no look). Only
a look an anonymous reader may fetch is used, of a public app and never a
sealed pull's. The picture is decoded, reduced to fit 480×300 and embedded as
a data URI (no dependency; the forge's own PNG codec), and the look's id and
taking name the card, so a new look is a new card. A look whose file cannot be
read leaves the card as it was.

Two of them carry a figure beside the words:

- **Map** — `/og/map/owner~name.svg`: the repository's dependency graph as a
  thumbnail, laid out exactly as `/owner/name/map` lays it out (ready green,
  working solid accent, blocked grey, waiting/held purple, parked amber,
  deferred and done faint), the critical path in the accent; beside it the
  open count, the critical path's length and ends, and the next issue a free
  hand would take; along the foot `ready · working · blocked · waiting · done`.
  Drawn from what a signed-out reader sees: no sealed issue, no run on one.
- **Audit** — `/og/audit.svg`: the policy score as a ring, the share of apps
  that hold (sound `contract.json` and no disagreeing probe; an app with no
  contract does not hold — 3 sound, one disobeying, one unread is 2 of 4,
  50%), with the top three findings worst first. Public repositories' apps only,
  as `/audit` shows them signed out.

The map page (public repositories) and `/audit` name their `.png` as
`og:image` with `twitter:card=summary_large_image`; every other page keeps the
forge icon.

## Develop

```sh
bun test              # protocol-level + adversarial suite
bun x tsc --noEmit    # zero type errors is the standard
bun run check         # exactly what the forge runs against every push
bun run check:record  # the same, and rewrites scripts/test-times.json
```

`bun run check` is the gate: the same command `forge.json` declares, so what
it says here is what the deploy will say. It type-checks once, then runs the
test files `scripts/gate.ts` admits — every `test/*.test.ts` not in its
`EXCLUDED` — as parallel `bun test` shards
(`scripts/test-shards.ts`): one per CPU the process may use, no more than
one per 512 MiB of the memory its cgroup allows (16 on the 16-CPU, 8 GiB
check cell; the old ceiling of eight left half of it idle, #2038), and
`FORGE_CHECK_SHARDS=2` turns that down on a small or busy host. Each
shard's output is written whole as it finishes; the log ends with every
failing test from every shard, or on green with one line — how many tests,
across how many files, in how long, then the slowest and fastest shard.

Two things keep a test's setup in milliseconds (#2038). `bunfig.toml`
preloads `test/helpers/preload.ts`, which hashes passwords at argon2id's
floor (8 KiB, one pass) instead of Bun's default 64 MiB, two passes:
making an account and signing it in was ~700 ms of a typical `beforeAll`
and is now ~15 ms; the forge itself never loads it. And `openDb` keeps
the empty database each migration list makes: the second fresh database
in a process is a copy of it rather than ninety-odd migrations again
(`createApp` ~100 ms → ~6 ms). No test file runs one subject long
enough to set the gate's floor alone: the studio's and the apps
adversarial suites are split by subject into `test/studio*.test.ts` and
`test/apps-adversarial*.test.ts`.

The check's first step is the gate-list audit (`bun scripts/gate.ts`), so an
`EXCLUDED` entry for a file that is gone, or one with no reason or issue,
fails in under a second,
before install-heavy work. `tsc` then runs `--incremental` with a 2 GB heap,
its build info in `.forge-cache/` (made first with `mkdir -p`: tsc will not
create the directory, and a checkout with no restored cache failed on it,
#1881). It is TypeScript 7, the native compiler (a
Go binary, so the bound is `GOMEMLIMIT=2GiB`): on this tree a cold check is
~3 s and ~17 CPU-s where 5.9 took ~30 s and ~50 CPU-s (#1864). 5.9 stays as
the dev dependency `typescript-api` only because `scripts/hollow.ts` walks
its AST, which 7.0 has no stable JS API for. The forge restores
`.forge-cache/` from the base's own green check and keeps it only from green checks of the default
branch (`src/checks/cache.ts`), so a pull's code never fills a cache another
check reads. The full gate also writes every file's time there, and the next
split weighs every file by measurement rather than the 41 the table named.

The fast tier picks by measurement. The full gate runs each file in a
`bun test` of its own under Bun's coverage (`--impact`; coverage is per
process, so a shard of many files would blur theirs together) and writes
the impact map: test file → the `src/**` files whose functions it called.
A file merely imported — its top level run, none of its functions — does
not count; that is the import graph again (#1794). Under the forge the map
is handed over as `$FORGE_CHECK_IMPACT` in the checkout: every check is
seeded with the one the last green default-branch run kept (under
the forge's data directory, `checks/impact/`, `src/checks/impact-store.ts`), and
only such a run, or the full gate on land, keeps a new one. By hand it is
`scripts/test-impact.json`. A diff intersected with it is the set of tests
the change reaches; the plan line says `by coverage: N changed files reach
M tests; src/x.ts reaches none` (a coverage gap). A measured test is
guessed by imports only against the changes the map cannot see; tests the
map has never seen fall back to the import-hop guess, and a change to
`forge.json`, `package.json`, `scripts/**` or `src/kernel/**` runs
everything. With no map yet the line says `by imports (no impact map)`.

Files go to shards by how long they take, not how big they are: longest
first onto the least-loaded shard, weighed from `scripts/test-times.json`
(file → seconds, from one recorded run). A file the table does not name
weighs its bytes at the table's own seconds-per-byte. If the table is
malformed, the log says it was refused and the split falls back to bytes.
A stale table only makes the split less even; it never drops a file.
Refresh it with one command after adding a slow test file, or when the
log's slowest shard is well over 1.5× its fastest:

```sh
bun run check:record  # the gate's own command, with test-shards.ts --record
```

`--record` runs each file as its own `bun test`, with as many running at
once as the gate runs shards. It rewrites the table only when every file
is green. Files it did not run keep their old times.

Every file is independent (its own forge, its own database, port 0), so a test that fails only beside another is a bug
in that test. Two things it will not do:

- **It never borrows your git configuration.** A test drives a real `git`
  against a forge it booted a second ago, and builds that child's
  environment rather than inheriting yours (`test/helpers/git-client.ts`) —
  otherwise a `GIT_CONFIG_COUNT` in your shell (a crew run sets one, holding
  its own forge credential) would send that credential to the test's server
  and every push in the suite would come back `401`.
- **It skips what this machine cannot run, out loud.** The OpenSSH interop
  tests need `ssh` and `ssh-keygen`; without them the log says `SKIPPING:`
  and names the tool (`test/helpers/tools.ts`). Install OpenSSH and they run
  again — the skip is conditional on the binary, never on anything else.

Every `test/*.test.ts` is in the gate unless `EXCLUDED` names it with a
one-line reason and the issue that owns admitting it, so a new test file is
gated the moment it exists and no pull edits a shared list for it (#2037).
`test/check-list.test.ts` goes red on an exclusion named twice, without a
reason or issue, or for a file that does not exist. An excluded file rejoins
the gate by deleting its `EXCLUDED` entry in a pull whose check is green and
whose description carries ten green runs in random order under load:
`bun scripts/flake-hunt.ts admit test/x.test.ts` runs the file ten times, each
its own `bun test --randomize` with a fresh seed beside busy loops, prints the
record and exits non-zero unless all ten are green.

A brand-new test file does not need that record: it joins the gate on its
own green check, not ten runs. That is accepted on purpose — a flaky new
test can turn the gate red once before anyone sees it — and the nightly
flake hunt below is the backstop that files it and quarantines it.

**No flaky tests.** Nightly, `.forgejo/workflows/flake-hunt.yml` runs every
gate file five times on a loaded box, each run a fresh seed that orders both
the files and (through `--randomize`) the tests inside them, nothing stopped
early. A file red in some runs and green in others is flaky: the hunt files
a `Flaky: test/x.test.ts` issue carrying the failure text, the seed and the
run, with the usual root causes to tick (a shared port, a real clock, order
dependence, a leaked server, a timeout set near the real duration, a tight
wall-clock bound); then
`bun scripts/flake-hunt.ts quarantine` moves every file an open `Flaky:`
issue the hunt itself filed (its author is the token's user and the forge
has not marked it untrusted) into `EXCLUDED` under that issue and proposes
the move as a pull; a file the issue names that no longer exists is skipped,
since its exclusion would turn the audit red. Nobody hand-edits the list. A file red in every run is broken,
not flaky, and the check already says so. The fix is the test's shape, never
a retry: `test/flake.test.ts` fails on `--retry`, `--rerun-each`, a bunfig
`retry` or a `{ retry: N }` anywhere the gate runs, and on any test that
bounds a measured time under 200 ms (a loopback fetch on a loaded runner
takes tens of ms): assert relative to a baseline from the same run, or bound
only the failure the test names. The workflow needs a
`FORGE_TOKEN` secret and a `FORGE_URL` variable on the mirror.

Bun's own `--randomize --seed=N` drives every hunt and admission run. Not
used: `--rerun-each` (one seed for every rerun, so ten reruns explore one
order) and `--parallel` (it changes the load the gate is judged under).

The gate also refuses hollow work. `test/hollow.test.ts` runs
`scripts/hollow.ts`, which names an exported function in `src/actions/` that
nothing that runs reaches — no route's handler, MCP tool, crew worker, CLI
command or terminal screen, followed from where the program starts — and a
screen — a GET path with no parameter that draws a page — that no reachable
page links to. `scripts/hollow-allow.ts` lists what main
carries today, each entry under the issue that owns it; an entry that is no
longer hollow turns the check red, so the list only shrinks.
`bun scripts/hollow.ts` prints the same lines on their own.

## Shape

```
src/
  main.ts     boot
  app.ts      composition root (one data dir = one forge)
  kernel/     zero-dep primitives: result, error, id, log, db, hash
  git/        bare repos, smart HTTP v2, cat-file readers, hooks, guards
  core/       domain: users, sessions, tokens, repos, events, schema
  actions/    every mutation once: authorize, mutate, record the event
  http/       router, request context, the server
  design/     the theme registry both surfaces render
  web/        SSR: html tag, design tokens, markdown, pages
  ssh/        a zero-dependency SSH server: transport, userauth, channels
  tui/        the terminal UI: runtime, widgets, screens, the ssh front door,
              and local/ — the same runtime over your own working trees
  cli/        `forge` on your machine: login, sync, status, pins
  apps/       a repository that runs: manifest, checkout, process, data,
              the runtime (environments), the proxy by Host
  runs/       run logs, appended live
  crew/       agents as child processes: the brief, Claude Code headless,
              the runner, dispatch off the outbox
```

Read `docs/ARCHITECTURE.md` for the principles and the reasoning behind them.
Contributing (human or agent) starts at `CLAUDE.md` — the invariants and how to
work here.

## What works today

- **Cut a wave** — Settings → *Cut a wave* (repository admins, same-origin
  POST; web-only, the terminal's settings hand over to the web) opens a pull
  adding `waves/<next>.md`, listing the pulls merged since the last wave and
  not already in an earlier wave. The headline and highlights are `TODO`
  placeholders; no model is called. It refuses, writing nothing, when an
  earlier wave does not parse (naming the file) or nothing new has merged.
  `/:owner/:name/waves` lists the waves on the default branch, newest version
  first, each line opening `/:owner/:name/waves/<version>` (headline, date,
  highlights with why, pulls as links; linked from that settings card); in the
  terminal, `V` in a repository opens the same list and Enter (or a click) on
  a row opens the same wave as plain text (a live browse of another forge says
  waves are only read on this forge).

- **Accounts & access** — register/sign in, personal access tokens with coarse
  scopes (ro/rw/admin), public and private repositories.
- **Git** — push and pull over HTTPS **and SSH**, browse code (tree, blob with line anchors,
  commit history) with README rendering and **syntax highlighting**, protected
  default branches (force-push and deletion refused, honest fast-forwards
  allowed).
- **System memory** — `/system`, for a forge admin who is a person (anyone else gets 403): the forge's RSS beside its JS heap (`heapStats()` from bun:jsc), hourly mean and max for the last 24 h, drawn on the server. Sampled once a minute into `memory_hour` in `app.db` (a week kept). RSS rising while the heap stays flat is native memory growth.  In the terminal the same admin has a **System memory** command in the palette: the last 24 hours as text rows (hour, RSS mean/max, heap mean/max in MiB), read-only. The account menu links `/system` for that admin.
- **Boards** — `/boards/data`, for a forge admin who is a person (anyone else
  gets a 404 on the page): the query is the URL (`?source=runs&aggregate=count&by=day&fcolumn=state&fvalue=failed`),
  drawn server-side as the chart chosen beside it (`chart=line|bar|area|number|table|heat`)
  with its points in a table; a point opens the rows behind it, keeping your filter.
  `series=<column>` splits each group by a second column: stacked area draws one band per
  value (eight at most, the rest folded into "other"), the heat strip one row per value
  (twelve at most) with time across, the table a series column; line, bar and number set
  it aside. Number is the latest group's value over a sparkline of all of them.
  `/boards` holds the boards themselves: a board is one JSON file
  (`{title, range, refresh: off|10s|1m, panels: [{title, chart, query, w, h}]}`) in
  `forge/boards`, a repo the forge owns and makes on the first board; every save is a commit
  by the admin who made it, and a file that does not validate is not shown. Make, rename,
  duplicate, delete, add/edit/remove/reorder panels, or pin the query on `/boards/data`.
  A board with a refresh redraws its grid on that beat through the live-region swap
  (`/boards/:slug/live`, etag'd). The same doors are in the API: `GET /api/v1/boards`, `GET|PUT|DELETE /api/v1/boards/:slug`
  (an agent or anyone but an admin is 403; a panel whose query cannot run is refused with 422). The same four doors are MCP tools (`boards`, `board_write`, `board_delete`; `boards` with a `slug` reads one) and, for the same person, a **Boards** screen in the terminal that lists boards and shows a board's panels as text. No dependency was added.
- **Issues** — labels, threaded comments, close/reopen, markdown.
- **Pull requests** — open from a branch, a **beautiful diff viewer** (syntax
  highlighting composed with intra-line word highlighting, mobile-first,
  collapsible files), merge-commit and squash strategies, conflict detection,
  and merge commits kept reachable forever via `refs/pull/N/merged`.
- **Review comments** — anchored to a diff line by content hash, so a
  force-push re-anchors them or marks them outdated, never misplaces them.
- **Forks** — alternates-backed (instant, storage-bounded), with cross-repo
  pull requests (fork → upstream) and detach-before-delete safety.
- **Organizations & teams** — orgs own repos; teams grant read/write/admin
  resolved through membership.
- **Live updates** — a server-sent-event stream turns comment threads live and
  flags new activity, no refresh.
- **Commit pages** — every commit's diff through the same viewer.
- **Settings** — visibility, branch protection, and labels.
- **The check lane is visible.** Checks run one at a time; an admin's home
  strip, the terminal dashboard's strip and `GET /api/v1/health` (`lane`) show
  the queue depth, the running check and its age, the median of the last
  twenty and the time to clear, and the 30-minute queue card names that cause.
- **A terminal UI** — `ssh` in for the whole forge: dashboard, code browsing
  with syntax highlighting, issues and pulls with live-updating threads, the
  diff viewer with inline review comments, merges, settings, orgs, tokens and
  keys. Six themes, remembered per account.
- **Origins** — connect GitHub, Forgejo or Gitea (device code, PKCE, or a
  pasted token), mirror repositories in with their issues and pulls, and write
  through to the origin on every comment, state change, label and push. Pins
  say what the local client keeps cloned.
- **Automation** — a JSON API covering repos, issues, forks, and orgs (the
  label-as-queue surface), a durable event outbox, and **webhooks** (HMAC-signed
  delivery with retry).
- **Removing an account** — `DELETE /api/v1/admin/accounts/:username` (admin
  only). An account that is the last owner of an organization answers 409 with
  the organizations named. Send `{"retireOrgs": true}` to preview: the answer
  lists each organization, its repositories (and the app each runs) and its
  teams, and changes nothing; the account's own repositories and the app each
  runs are listed too, under `own`. Send `{"retireOrgs": true, "confirm": true}` to
  do it: apps are stopped, repositories deleted, organizations retired (the
  name stays taken), then the account. If a repository will not go, the answer
  is 500 with `failed` and `removed`; what is left is intact and the same call
  again finishes the job. The accounts page offers the same flow: Remove →
  "Remove the organization too" → a confirm page listing everything that goes.
- **Apps** — a repository that runs: production on the default branch, a
  preview per open pull with its own copy of the data, served by hostname
  from the forge's own port, every deploy a run and every run a check.
- **The crew** — agents as accounts with nothing but a run-scoped token,
  working issues in the background with Claude Code and proposing through
  pulls a person merges.

Pages render without a line of JavaScript and are designed thumb-first. Six
premade themes (from warm paper to polar night) switch instantly and persist in
a cookie — even that works script-free. Still **zero runtime dependencies**.

Not yet: containers around apps, custom domains, and a gate that lands a
pull on its own once review and checks agree.

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

## Check tiers

`forge.json`'s `check` may declare `fast` beside `run` (the full gate; `full` names it explicitly). `bun scripts/test-shards.ts --tier fast --diff <base>..<head>` runs the tests that touch the diff (changed, named for a changed source file, or importing one within two hops), every test the times table records under 1 s, and any named by `--learned a,b`. `src/checks/tiers.ts` decides; it adds no dependency.

In the forge itself: a pull's check runs `fast` when the manifest has one, in a clone holding the fork point and the head as `FORGE_CHECK_BASE` and `HEAD` (`origin/main` is not a ref there), with `FORGE_CHECK_LEARNED` naming tests earlier land attempts taught the pull (`src/checks/history.ts`, `learned.ts`). Landing (`landIfGreen`) runs `full` once on the merge with its base before merging (`src/checks/landing.ts`); red comments on the pull with the tests named, is remembered per head and base, and the files ride the pull's next fast run. The pull page's checks line shows the tier words. The checks line (page and terminal) also names the base tip the fast check merged with ("checked against main at abc1234"); `GET …/pulls/:number/checks` returns it as `run.baseOid`, empty for a default-branch push and for the `full` land gate. When the base has moved since that green, the page's line reads "Checked against an older main" (a clock, not a green mark) and the terminal's reads `checks: passed against an older main`. `GET /api/v1/repos/:owner/:name/pulls/:number` and the MCP `pull` tool carry `checkStale`, true only for an open, unmerged pull whose last check recorded a base that is no longer the base branch's tip. With `require_checks` on, such a stale green counts as a check still to come (`checksHold` in `src/checks/stale.ts`): the page reads "Waiting on checks" and disables **Merge pull request**, the terminal refuses `m` the same way, and the inbox's `look` ask and an autonomous repository's `review` ask wait for the re-check. The ask side works from the stale-ask sweep's last read of the base tip, so it drops after the next sweep, not the instant the base moves. `mergePull` itself does not yet refuse a stale green (API and MCP merges are not held).

While the default branch's own last check is red, the forge holds its pulls' checks queued rather than fail each one on the same test (`src/checks/red_main.ts`): the vitals carry one card naming the failing test and how many checks wait, and main going green releases them. A check a person asks for again runs at once, and no check is held more than 20 minutes, so the pull that fixes main can always show green.

## Flags

A forge admin sees every declared flag at `/settings/flags` (Settings → Flags): why it exists, its default, the owner issue and its live value. Set it for the whole forge, for listed user ids or roles, or for a percentage of people; Clear returns it to the default. A change is validated, kept in the change record and live on the next request, with no restart. In the terminal the same admin opens the command palette (`ctrl+k`), picks Flags, and presses enter to set a flag from a line such as `forge=on users=u1,u2 roles=admin percent=30` or `x` to clear it; an agent is never an admin there either.

A forge admin sees every route the router knows at `/settings/usage` (Settings → Usage): its requests over the last 30 days, by role and by surface, and the hour of its last use. Routes with no request in the window are listed first, never-used ones before the longest-unused, as candidates to drop; the rest follow by count. Counts are per pattern, not per method. `usage` is also a boards source, for an admin only (an agent is refused); its `hour` column is text like `2026-10-16T13`, so group by a column such as `pattern` or `role`, not by a time bucket. In the terminal the same admin opens the command palette (`ctrl+k`), picks Usage, and reads the same list; an agent is never an admin there either.

## Limits

Every limit the owner can hit is declared in `src/settings/limits.ts` with its default, bounds and reason, and changed live by a forge admin at `/admin/limits`, `PUT /api/v1/admin/limits/:key` or the `limits` MCP tool (never by an agent). Each change is kept with who made it.

Per-account quotas (`src/settings/quotas.ts`) — how many `repositories` and `apps` one account may own, how many `previews`, `runs` and `checks` it may have going at once — are set the same way: **Account quotas** on `/admin/limits`, `GET`/`PATCH /api/v1/admin/settings` (`{"quotas": {"repositories": 5, "apps": null}}`) or the `quotas` MCP tool (dry by default, admin scope, never an agent). A value is a positive whole number, or empty/`null` for no limit, which is the default; anything else is a 422. Every change is kept with who made it and listed beside the form. The `apps` limit is enforced (`src/actions/app_limit.ts`): with one set, an account owning that many apps is refused one more, unless the actor is a forge admin; with none set nothing is asked. The check and the insert are separate statements, so two concurrent creates can pass by one. The refusal reads "This account is at its limit: 3 of 3 apps. Remove one to make room." and each door answers it its own way: the API (`POST /api/v1/apps` and `POST /api/v1/repos/:owner/:name/app`) a 403 `{"error": "app_limit", "message", "limit", "count"}`; the new-app page and the app settings form a 422 with the sentence on the form; make-it-yours the same sentence as an invalid error, before the fork, so no repository is left behind. The `repositories` limit is enforced too (`src/actions/repos.ts`): with one set, an account owning that many repositories (sealed forks are not counted) is refused one more by create, fork, make-it-yours, mirror, migrate and new app, before anything is made on disk. Forge admins and agents are exempt, and creating under an organisation is not counted: the quota is per account, so only a repository the actor owns itself is asked. The refusal reads "2 of 2 repositories"; the API answers 403 `{"error": "repository_limit", "message"}`, the pages say "Not made: 2 of 2 repositories." on the form (a 422), and the terminal shows it as a toast. The check and the insert are separate statements here as well, so two concurrent creates can pass by one. The `storage` limit (megabytes, `src/core/storage.ts`) bounds the bare repositories an account owns plus its apps' data: a push, create, fork, make-it-yours, mirror, migrate or new app by a non-admin, non-agent account at the limit is refused before anything is written (the account asked is the owner the repository would belong to, an organisation included); a push is refused before git runs, as a git error over HTTP and SSH ("storage limit reached: 1.9 GB of 2 GB"), and a push that would pass it is capped inside git (`receive.maxInputSize` = the room left) so it is stopped in quarantine and the repository is as it was. Every other door answers a refusal as `storage_limit`, not `repository_limit`: the API a 403 `{"error": "storage_limit", "message"}` with the message "…storage limit: 1.9 GB of 2 GB", the pages "Not made: …" on the form (a 422), the terminal a toast. A mirror's periodic sync fetch and a migrate import mark the figure stale without walking the disk, so the next check measures again and no account can mirror past the limit unseen; the one fetch that crosses the limit is let in, the next create is refused. The figure is cached per account in memory and re-measured in the background after each push, walked on the request path only when it must be: the first look at an account waits for one walk, and so does the first check after a push, create, fork, mirror or delete changed the disk (a walk already under way is joined, not repeated). An account found at its limit is measured again before it is refused, so a deletion frees it with no restart, but at most once every 5 seconds, so retries by a locked-out client do not scan the disk. Two pushes at once can each pass. Three more limits bound what an account has going at once, each unset by default and never asked of a forge admin: `previews` (live previews), `runs` (concurrent agent runs) and `checks` (concurrent checks), counted across the account's repositories and asked before the thing starts. A preview past its limit does not start: its deploy run — the check the pull shows — fails with "not started: 1 of 1 live previews", and a sleeping preview stays asleep when woken at the limit. A run or check past its limit stays queued, with "queued, not started: 1 of 1 concurrent runs" (or "concurrent checks") in its log, and starts when one of the account's own ends; none is dropped. An admin sets the three running limits exactly like the other two: the `previews`, `runs` and `checks` fields on `/admin/limits`, or `{"quotas": {"previews": 3, "runs": 2, "checks": 1}}` to `PATCH /api/v1/admin/settings`. In the terminal the same admin opens the command palette (`ctrl+k`), picks Account quotas, and sees every key with its limit and last change; enter sets one (empty for no limit), `x` clears it, both through the same validation.

The forge setting `signup` (`src/settings/signup.ts`) is `open`, `invite` or `closed`, and `open` is the default. A forge admin who is a person changes it live — **Signup** on `/admin/limits`, `PATCH /api/v1/admin/settings` (`{"signup":"closed"}`) or the `signup` MCP tool (dry by default, admin scope, never an agent) — with no restart; any other value is a 422. `FORGE_SIGNUP` sets it at boot, and a wrong value stops the boot with a plain message; while it stays set, every restart or deploy writes it again over a change made on the page (kept as a change by `boot`), so unset it to let the page decide. Every change is kept with who made it and when, and listed beside the form. While signup is `closed` (and `invite`, until #1143), `/signup` is one sentence with no form, the API and passkey signup answer 403 `signup_closed`, the terminal offers no Create account and refuses, and a first edge sign-in for a new name is 401. Existing accounts still sign in, and the forge's first account is always made.

## Choosing among variants

A tell with `variants: n` starts n builders whose pulls share a variant group.
`/:owner/:name/variants/:group` is the deck: one card per open sibling with its
look and preview, linked from each sibling's change page. A writer likes or
dislikes each (plain form posts; on touch a mostly-horizontal swipe, with a
confirm before a dislike), through `POST /api/v1/repos/:owner/:name/pulls/:number/variant`
(`{"answer","reason"}`), the `variant` MCP tool, or `+`/`-` on a pull in the
terminal. Each person has one vote per pull, kept as a `lean` row in the
decision ledger. A dislike closes the pull and leaves its one-line reason as a
comment the builder reads; the last open sibling shows Ship. Readers see the
cards and no buttons.

While two or more siblings are open and none has shipped, a writer's feed holds
one **Choose** item for the group ("choose among N open variants of …") that
links to the deck, whatever the number of siblings; it is never muted away.
Once a sibling ships or all but one close, the item leaves the feed. The
terminal has no feed; the item is in `GET /api/v1/feed` and the MCP feed tool
as kind `choose`.

### OG cards as PNG

`/og/{repo,app,issue,pull,run,map}/<ref>.png` and `/og/audit.png` are the same public cards as the `.svg`,
rasterized (1200×630) for the link previews that refuse SVG. Same refs, same
404s, same ETag-per-inputs (suffixed `-png`). Each PNG is rendered once and kept
under `$FORGE_APP_DATA/og-png/<sha256 of the inputs>.png`; the cache holds at
most 512 files (`OG_PNG_CAP` in `src/web/og/png-cache.ts`), least recently used
out first. Cold is about 120 ms, warm a file read. If the rasterizer will not
load or render, the route answers 503 with `retry-after: 30` and logs; nothing
else notices, since the rasterizer is only loaded on the first PNG request.

**Dependencies (one, vendored, not installed):** `package.json` `dependencies`
stays empty — the preview has no install step, so the files are committed under
`src/web/og/vendor/`, unmodified.

- *resvg* (`@resvg/resvg-wasm` 2.6.2, `resvg.mjs` + `resvg.wasm`): an SVG
  renderer compiled to WebAssembly, so no native binary or platform build. Why:
  rasterizing text and gradients correctly is not a 20-line file. 2.4 MB wasm +
  17 KB glue. Licence MPL-2.0.
- *DejaVu Sans, Sans Bold, Sans Mono, Sans Mono Bold* (2.37): the fonts the PNG
  is drawn in, so its text is the same on every host (the SVG names system
  fonts; the card clamps text with a deliberately wide estimate, which these
  fit). 2.0 MB. Free licence, `vendor/DEJAVU-LICENSE`.

Not done: the SVG route is unchanged and still the card's source of truth; the
rasterizer runs on the main thread (about 100 ms once per distinct card).

Every read of a flag is counted in memory by UTC day and variant (on or off) and written in one batch every ten seconds and at exit, so a request runs no extra query. Beside each flag, Settings → Flags shows its reads per variant for the last 7 and 30 days. When one variant leads, "Make on/off the default" sets the flag to that value for everyone (user, role and percentage rules are cleared), and opens an issue on the forge's repository asking the crew to remove the losing path and the flag; if the issue cannot be opened, the flag is left as it was. The button shows only when the 30-day leader has at least 50 reads in all, the variants are not tied, and the flag's forge value is not already the leader. In the terminal the Flags screen shows the same `Uses, 7 days / 30 days` line for the flag under the cursor, and `w` does the same as the button (same admin, non-agent gate). Counts are of reads, not of people.
