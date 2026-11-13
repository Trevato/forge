# Spawn — a forge births a forge

Design for issue #389. A forge can make a child: a new org and instance with
chosen apps, the crew's briefs, its own keys and domain. The child follows its
parent, takes its updates, and proposes back. Built as linked issues; this page
is the shape they share.

## Never copied

The parent's secrets, tokens, SSH keys, agent credentials, run ledger, issues
and user accounts. The child mints its own. A test in #420 and #422 proves it.

## The order (what waits for what)

| issue | what                                                    | waits for        |
| ----- | ------------------------------------------------------- | ---------------- |
| #420  | spawn plan: one validated value, dry-run                | #383             |
| #427  | placement seam; hosted inside the parent today          | #420             |
| #2926 | `cell` placement: a child as its own `bun src/main.ts` in a cell held to its size (`spawn/cell.ts`); `hosted` where the host cannot hold a cell. The spawn answer and the children list say `placement` | #2925 |
| #6023 | a cell child boots inside a forge that is itself in a cell (nothing under the cell's own `/run` is remounted read-only); its cell starts behind the first request, which is answered 503 with `Retry-After` until it is up, and a cell that fails turns the child hosted; the terminal's family lines say where each child runs | #2926 |
| #421  | spawn action: org, instance, apps as repos, briefs      | #420, #427       |

`src/actions/spawn.ts` (#421): the child lives in `<data>/children/<bodyId>`; the parent keeps a ledger line in `<data>/spawn/<name>.json` so a retry resumes or answers. Subscription names are in the plan but not yet created in the child (a subscription is a token).

| #422  | first boot: direction, own tokens, domain, claim link   | #421             |
| #423  | cross-forge following over HTTPS, read-only token       | #422            |
| #424  | propose upstream as a pull on the parent                | #423             |
| #425  | family tree across forges, signed heartbeats            | #423             |
| #426  | '+ New forge' in the studio                             | #421, #422, #339 |

External bodies (Cloudflare, Fly, metal) are decided by spike #339 and arrive
as a second implementation of the placement seam (#427), in their own issue.
A self-hosted front door on celld is weighed in `docs/research/celld.md`.

## First boot and the claim link (#575)

`direction` (optional, at most 2000 characters) is the spawner's words for what the child is for. Spawn writes it as each app's direction and carries the crew's roles (planner, builder, reviewer) from the parent's copy of each app. The first time the child runs, `src/spawn/first-boot.ts` opens the direction issue on its first app and assigns it to the planner. The child's organisation records that it booted, so a restart opens nothing more.

Spawn mints one claim link (`src/spawn/claim.ts`): 32 random bytes, returned once as `claimUrl` in the `Spawned` result, kept in the child only as a sha256, single-use, and dead after 24 hours. The link is `https://<child>/claim#<token>`: the secret rides the fragment, which a browser never sends, so no server, edge or proxy log and no Referer sees it. `GET /claim` serves the form with nothing in it; a small script moves the code from the fragment into the form and drops it from the address bar (without JavaScript the code field takes a paste). The older `/claim/<token>` path form is gone (#1074): every `/claim/<anything>` is a 404. `GET /claim` shows the form and spends nothing, because a link unfurled in a chat app must not claim itself. `POST` (same-origin) makes the account, an admin and an owner of the child's organisation, burns the link in the same statement that checks it, and signs the person in. A used, expired or made-up link says which.

Any site admin of the parent, not only the one who spawned it, can re-issue the link of a child nobody has claimed: "Send a fresh link" on `/forges`, `POST /api/v1/forges/:name/claim-link`, or the MCP `claim_link`. The child keeps one claim row, so the new link replaces the old, which stops working at once. A claimed child is refused (409). The new link is shown once and never kept by the idempotency table.

The operator of the parent can instead make the child's first admin from a terminal: `bun src/main.ts --first-admin --child <name>` prints a one-time code (15 minutes, hash-only, refused once anyone is admin; `src/core/first_admin.ts`) for the child's `/first-admin` page (a passkey) or `POST /api/v1/first-admin` (a token for a headless agent). Its organisation is handed over exactly as a claim hands it over, and the claim link then reads as owned. If the child's admins later have no working credential left (a headless admin whose token lapsed), the same command prints a recovery code that buys the stranded admin a new expiring token at `POST /api/v1/first-admin/recover`; it is refused while any admin can sign in.

A claim link is a live secret, so it stays out of an agent's conversation (#839). The MCP `spawn` makes the child and answers without `claimUrl`, saying where to get the link. The MCP `claim_link` changes nothing unless sent `reveal: true`. A person admin gets a fresh link on `/forges`, in their own browser, and hands it over. Both tools take `reveal: true` to put the link in the conversation on purpose, and the answer then says plainly that it is a live secret. Nothing on the parent stores a link to read later: a stored link would be one more place to take it from, and re-issuing already gives a fresh one.

A claim is bound to a spawned forge: it is read only from the organisation `parent.json` names, so a forge without `parent.json` answers 404, a row under any other account is never consulted, and a forge that already has an admin cannot be claimed. `keepAccess` (default false) decides who can see the child afterwards, and the claim page says which before anyone submits. With false, claiming removes the spawner's account from the organisation's Owners (the new owner can invite them back); with true, the page names the spawner and where to remove them. An idempotent replay of `POST /api/v1/forges` never returns or stores the link: `claimUrl` is kept as "shown once, in the first answer".

## The child's own keys, domain and model key (#576)

Spawn makes the child's `secret.key` and SSH host key in the child's own directory, so they exist before its first boot and are never the parent's. The child's address is `<name>--<parent's host>`, from the placement (one label under the platform apex). It is recorded as `url` in `parent.json` and shown on the child's home ("Your forge: …"). Hosted by another forge, the child prints `FORGE_APP_SSH` verbatim wherever it says how to connect, and says the terminal is off when that is unset.

A spawner may give the child one credential: `modelKey`, an API-billed key (`sk-ant-api…`), with `budgetUsd`, a whole-life budget in dollars from 1 to 1000. A subscription token (`sk-ant-oat…`) is refused, because it is a person's own plan. The key never enters the plan, the dry run, the answer, the ledger or the idempotency table. In the child it is sealed with the child's own key as the account `starter` and granted to its organisation's crew. The budget is locked on that account (`lockBudget`): it is enforced where every run picks its account, whoever started the run and on whichever repository, and the child's admin cannot raise it, only add their own key. A retry with a different key is refused; a key is given once. Said plainly in every answer that carries a key (`keyNote`): the budget holds while this forge hosts the child, whose admin has no shell or database access; on a machine the child's owner controls, only a spend limit set at the provider binds the key, so use a key from a workspace with its own spend limit. The MCP `spawn` tool refuses `modelKey`, so a secret never passes through an agent's conversation. With no key the child is in a clean state: its pages say the crew has no model key yet and where an admin adds one.

## The family across forges (#425)

`/family` draws the forge-level tree as nested lists: the parent (from `FORGE_PARENT_URL`, or the `upstream` in a spawned child's `parent.json`), this forge, and the forges it sent, each with last seen, version, releases behind this forge, and open proposals. Anyone may see the parent; only this forge's admins see children. Bounded: 100 children, four levels.

Children report in; the parent never reaches in. Every ten minutes a spawned child POSTs `/api/v1/heartbeat` (`src/spawn/heartbeat.ts`): `{name, at, version, openProposals, children}` and nothing else, signed HMAC-SHA256 over the body in `x-forge-signature` with a per-child `beatKey` that spawn put in the parent's ledger and the child's `parent.json`. A name the parent did not make, a bad signature, a time more than ten minutes off, a replay or any extra field gets the same 404 and changes nothing. The last beat per child is kept in `<data>/beats/<name>.json`. A child silent for thirty minutes reads "quiet", never an error; one never heard from reads "has not reported yet". Children made before this change have no key and stay unheard until respawned.

A hosted forge gets the same one-click connect for origins its parent holds an OAuth application for (`src/spawn/origin_broker.ts`, `src/origins/broker.ts`). The parent is the OAuth client; the child receives only its own person's token. A child asks over the same door and key as the heartbeat (`POST /api/v1/broker/origins`, signed over the body) which origins it is offered: kinds, hosts and names, never an id or secret. GitHub's device grant is begun by the parent and polled by the child, so the token never reaches the parent. A code flow (Forgejo, Gitea) sends the browser to `GET /broker/origins/start` on the parent with a start the child signed (child, host, a state it keeps against its person, a PKCE challenge, the one return path, a time); the parent runs the authorize and the callback at its own registered address, checks the account as its own sign-in would, seals the tokens against a one-time code for at most a minute, and sends the browser to the child's address (derived from its name, never from a request) with that code and the child's state. The child checks the state against its person, redeems the code with the verifier, and connects through `completeConnect`, the function the device and code flows end in. A refresh asks the parent again (the secret is its), which stores nothing. A parent that holds no application offers nothing, and the page is the token form as before.

## A client's forge in one form (#1608)

`/forges/new` is the whole path: a name, the owner's apps to fork, optionally one fresh app from a one-line description (`fresh`, at most 200 characters, one line), a budget with a model key; it ends in one claim link, shown once. Each picked app is a fork: its full history is copied (the same commit ids) and the child follows it from the first minute ("Apps stay linked", below). A fresh app is a private repository in the child with a README, a `forge.json` and a tiny `index.ts` that answers `/` with the sentence, escaped; its name is the sentence's slug, never one of the forked names. A custom domain is not part of this: the child is reached at `<name>--<host>` and nothing else is promised. The same field is on `POST /api/v1/forges` and the MCP `spawn` (`fresh`). It is absent from the plan when unsaid, so older plan hashes are unchanged.

## Choices

- Following across forges is HTTPS git with scoped tokens, because hosted
  children have no SSH.
- The parent never reaches into a child; children report in with a signed
  heartbeat carrying counts and version only.
- A proposal can only create branches under `child/<name>/` and open pulls.

## Callers

`POST /api/v1/forges {name, apps[], crew[], direction?, keepAccess?, modelKey?, budgetUsd?, size?, template?, dryRun}` (rw token; a person who is signed in, and a paid plan only from an admin, a gift code, or a paid order below) and the MCP `spawn` tool share `src/spawn/door.ts`. `size` is `small` (default), `medium` or `large`; anything else is a 422 on `size`. It is recorded in the plan, the ledger, `parent.json` and `GET /api/v1/forges`, but not enforced yet: it limits nothing. `dryRun` is true unless it is `false`: the answer is the plan, what is left behind, and `firstAdmin` (the caller's username, or `null` for an anonymous plan, where whoever claims the child becomes its admin), and nothing is made. `GET /api/v1/forges` lists the ledger's children. The child's org is its name; `crew` names the agents whose briefs travel. Errors: 401 unauthorized, 403 forbidden / cross_origin, 422 invalid, 409 refused / exists, 500 failed — each with one sentence. The MCP lets an `ro` token plan, never make.

A spawn may also name a `size`: `small`, `medium` or `large` (`src/spawn/sizes.ts` maps each to CPU, memory and disk). It is recorded in the plan only when given, so a plan without one hashes as it always did, and an unknown size is a 422 on `size`. The New forge page and the terminal form both offer it, small preselected and not sent; the page shows a refusal beside the select, linked with `aria-describedby`. Nothing enforces the limits yet, and the table's numbers are provisional. `GET /api/v1/forges/sizes` (no sign-in, ETag, cached for 5 minutes) and the MCP tool `sizes` give the same answer — each size's CPU, memory and disk, read from that table, and one sentence on what it is for — so a page or an agent offering a size reads it there.

## Choosing a template (#7533)

A template is a named starting point for a new forge's apps, listed in `src/spawn/templates.ts`: each has an `id`, a `title`, one sentence `says`, and a `source` — `builtin` (its files are this forge's code) or `repo` (read from `repo`, an `owner/name` on this forge; none yet, #7536). Built in are `blank`, the default and what a spawn has always made (the forked apps and an optional `fresh` one), and `starter`, the app `/apps/new` starts from (`scaffoldFiles`, `src/apps/template.ts`).

`POST /api/v1/forges` and the MCP `spawn` take an optional `template` id. An unknown id is a 422 on `template` naming the valid ids. Absent or `blank`, the plan is the one it always was; any other id is named in the plan, the ledger line, `parent.json` and the child's row in `GET /api/v1/forges` (absent there means `blank`). Because it is in the plan, a retry with another template is refused as a different child. A `starter` child begins with the template's files (#7535, `src/spawn/template_birth.ts`): one commit, no history and no upstream, in a new private repo of the child's organisation named for the `fresh` sentence (which becomes its description; no second repo) or `app`. `parent.json` records `template: {id}`. Only tracked files travel, nothing from the "never copied" list; a retry finds the repo and leaves it.

`GET /api/v1/forges/templates` (no sign-in, ETag, cached for 5 minutes) and the MCP tool `templates` give the same answer: `{ templates, default }`, `blank` first.

## The forge's own code, and the chain (#1085)

Every child is born with `<org>/forge`: a fork, with full history, of the
repository its parent forge is deployed from (`forgeRepo`; a spawned forge
has none configured, so it uses the fork it was born with). The child's owner
may change it freely. A grandchild forks the child's `forge`, so the chain
reads child → parent → … → root.

`parent.json` keeps `forgeCode`: `repo`, `upstream`, `mode`, `tip` (the
upstream's tip at birth) and `chain` (the ancestors' hops, copied from the
parent's own `parent.json`, so a grandchild reads the whole chain offline).
The spawner chooses `followMode` in the spawn input: `take-updates` (default) or
`tell-me`; it is part of the plan. A plain fork (not a spawned forge) defaults to `tell-me`. `/:owner/forge/following` on the
child shows the chain, root first, one line per hop with its mode and how
many commits of its own it had when the next hop was born (the last hop is
counted now). What the modes do is in
"Following the parent forge" below.

Every door reads and cuts the chain the same way: the page
(`GET /:owner/forge/following`), `GET /api/v1/repos/:owner/forge/following`
(`chain`, `severedAt`), `POST …/following/sever` (rw token, owner only), the
MCP `following` and `sever` tools, and the terminal's **Chain** command.
Sever's one implementation is `severForge` in `src/actions/follow.ts`.

A child's heartbeat adds `forgeTip`, `severedAt`, `mode`, `upstreamBehind`
and `conflict` when it carries a fork; `/family` on the parent shows
`code at <tip>` or `follows nothing since …`, and a line such as `takes
updates · 3 commits behind · conflict open` (`tells its owner` for
`tell-me`, `up to date` at zero behind). `conflict` is the state at the
child's last hourly check, not a live look at whether the issue is still open.

## Apps stay linked (`spawn/app_links.ts`)

An app a spawn sends down is the parent's repository with its whole history, and it stays linked to it: in the child it is an ordinary followed upstream (`repo_upstream`, the `upstream` tool) at `<parent>/<owner>/<name>.git`, with `via: parent` and the follow mode `take-updates` (or the `followMode` chosen at spawn). There is one follow mechanism for an app, an outside upstream and a connected origin; the forge's own code (`forgeCode` above) is the other record, and `follow_mode` and `sever` answer for both.

- **Taking updates.** When the parent's default branch is ahead and the child's holds nothing the parent lacks, the child's branch moves to the parent's tip (a fast-forward, the same commit ids, a `push` and a `forge.updates_taken` event, so the app redeploys). When the child has commits of its own nothing is rewritten: the new commits come as the `Upstream: N new commits` pull, or, when they conflict, as the converge issue for the crew. `tell-me` only ever proposes.
- **When it looks.** The parent says so: a hosted child awake in its process is checked the moment an app lands (`watchLandings`) and when it wakes; a child in a cell hears the tips in the answer to its heartbeat; otherwise the existing 30-minute follow poll.
- **A private app** is read with a follow token: a read-only proposal token (`proposal_token.read_only`) bound to that one repository, which fetches it and does nothing else (no push, no pull, no other repository). The child seals it with its own key (`repo_upstream.credential_enc`); the plain copy is never kept. The parent ends it with `proposal_tokens`, and by the child's sever.
- **Severing** is one action, `sever` (a button on the repository page, `POST /settings/upstream/sever`, `follow_mode` `dont-follow`): the link goes off, the credential is forgotten, the day is kept so a repair never links it again, and the parent's next pass (`reconcileAppLinks`, five minutes) ends the token it minted. History and files stay. The parent never gains access: `keepAccess` is a separate choice.
- **Children made before this** are repaired by their parent: `reconcileAppLinks` offers each child, from its ledger, the link to every app it was given that has none (written into the child's `parent.json` `apps` entries as `url`, `branch`, `mode`, `anchor` and, for a private app, `token`); the child applies the offer (`applyAppLinks`, at boot and every minute) only when the repository's history holds `anchor`, the parent repository's first commit, and its owner has not severed or set the repository up otherwise. The owner sees a `repo.upstream_follow` event saying "`<repo>` now follows `<upstream>` on `<host>`: ... Sever it". `/forges` lists, per child, each app it was sent and whether it still follows.

## Following the parent forge

An hourly check (`CHECK_MS`, `src/spawn/upstream.ts`) fetches the parent's
code into the child's `forge` repository under `refs/upstream/*`. What it
learned (the parent's tip, how far behind the child is) is kept in
`upstream.json` under the app's data directory. Fetching changes no branch.

The owner's `followMode` decides what happens when the parent has new commits:

- `tell-me` sends one inbox card per new tip, listing its commits.
- `take-updates` (the default) fast-forwards main when the fork has no commits of its own; otherwise it opens one pull from the branch `forge/take-updates`
  (`TAKE_BRANCH`) holding the parent's code, and updates that same pull when
  the parent moves again. The pull carries the check like any other.

The chain page, the API, the terminal and the MCP also offer "take now",
which opens the same take pull. Sever stops all of it.

What never happens: the default branch is never moved, and nothing merges
itself. A person merges the take pull.

**Sever** (`POST /:owner/forge/following/sever`, owner only, same-origin,
type `sever`) writes `severedAt` into `forgeCode` and nothing else: the
fork, its history and the record of where it came from stay, and nothing
leaves. The page and the parent's tree then say it follows nothing since
the date.

A spawned forge's own code is a fork of its parent's (`<org>/forge`, chosen
`followMode` `take-updates` (default) or `tell-me`; in `take-updates` the hourly check fast-forwards a fork with no commits of its own, and puts what the parent gained in a pull when the fork has its own.
 Once an hour, and
on demand, a forge that follows and has not severed fetches its parent's code into
`refs/upstream/*` of its own `<org>/forge` (no branch of the fork moves) and keeps
`{ behind, parentTip, checkedAt, error }` in `upstream.json` under `FORGE_APP_DATA`;
the count shows on the chain page, in the terminal's **Chain** (`c` checks now), and as
`upstream` in the API and MCP payloads. `POST /:owner/forge/following/check` (a writer,
same-origin) checks on demand; a fetch is cut at 60 s and a failure is recorded, not
thrown. In `take-updates` the check first fast-forwards main itself when the fork has no commits of its own (compare-and-swap, so a push in between wins). Otherwise it puts `refs/upstream/HEAD` (a fast-forward, or a clean merge commit) on the
fork's `forge/take-updates` branch and opens one pull, "Take updates from <parent>", into main, or updates
that pull when it is open (`spawn/take.ts`); the fork's check runs on it like on any pull and a person merges it.
Main is moved only by that untouched-fork fast-forward; a fork with its own commits gets the pull and a person merges it. It is recorded as `taken` in `upstream.json` (the chain line
reads "N commits from your parent are in pull #P") and as a `forge.updates_taken` event; a pull closed unmerged
is not reopened until the parent moves again. `forge/take-updates` belongs to the check: a commit a person pushes there is overwritten by the next check that finds something different to put on it (open a branch of your own to build on it). On a conflict nothing changes and one open issue,
"Take updates from <parent>", names the files. In `tell-me`, a new parent tip makes one inbox card for the owner (an issue on the fork assigned to them, "Your parent forge has N new commits", linking the chain page); `toldTip` in `upstream.json` keeps it to one per tip, and `take-updates` or a severed link makes none. Its chain
to the root is at `/:owner/forge/following`, in `chain` of `GET
/api/v1/repos/:owner/forge/following` and the MCP `following` tool, and in the
terminal's **Chain** command; the owner severs it with the page's Sever,
`POST …/following/sever` or the MCP `sever` tool (nothing is deleted). Taking
updates into a conflict opens the converge issue at every door. See
`docs/FOLLOWING.md`.

## One click from a stranger to their own forge (#2914)

The program: a stranger makes an account with a username and a password (email
optional, no open-platform, Forgejo or edge account anywhere in the path),
presses "Make my forge", names it and picks a size, and lands as the first
admin of a live forge, with any public app of this forge included, in under
three minutes. An agent with a token does the same by API or MCP. What is
already here: the anonymous door and its rate limit, the claim link, public
apps as forks, and the MCP `spawn`. What is missing is built as linked issues:

| issue | what                                                              | waits for    |
| ----- | ----------------------------------------------------------------- | ------------ |
| #2923 | sign up with username + password, email optional                  |              |
| #2924 | the claim takes username + password, email optional               | #2923        |
| #2925 | sizes small/medium/large in the plan, with a host quota           |              |
| #2926 | a `cell` placement: each child its own process, held to its size  | #2925        |
| #2927 | "Make my forge" for any signed-in person, per-account limit       | #2925        |
| #2928 | the door ends signed in on the child, no code to copy             | #2927, #2924 |
| #2929 | an agent does it all unattended by API and MCP                    | #2923, #2927 |
| #2930 | end-to-end test, each step named when it breaks                   | #2928, #2929 |
| #2931 | nightly drill of the same path on the vxrail                      | #2930        |
| #2932 | /boards: forges made, time to live, failures                      |              |
| #2933 | /forges: an owner's forges side by side, use against size         | #2925, #2926 |

## Child quota

`FORGE_CHILD_CPUS`, `FORGE_CHILD_MEMORY_MIB` and `FORGE_CHILD_DISK_MIB` declare
what all children together may hold; each is the sum of the sizes in the spawn
ledger (`spawn/sizes.ts`). **Unset means no quota.** A spawn that would pass a
declared limit is a 409 `refused` with one sentence naming it, and the New
forge page shows that sentence above the form when even a small forge would
not fit (`spawn/quota.ts`).

## The paid path: `/pricing`

A visitor with no account buys a forge. `GET /pricing` (public) lists the plans from the setting with their size, price and crew credit. A paid plan's button posts the forge's name and an email to `POST /pricing/order`, which checks the name is free (not a user, a child, a reserved word or another order's hold), writes an **order** (`forge_order`: name, plan, email, state `pending`) that holds the name for 30 minutes, and redirects to the provider's checkout. The buyer's ticket is an HttpOnly cookie scoped to `/pricing`; only its hash is kept.

When the order turns paid (the `checkout.session.completed` webhook, or `/pricing/done` asking the provider for the session, whichever is first) one `UPDATE … WHERE state = 'pending'` wins and goes on: `spawnDoor(..., { paid: true })` makes the forge on that plan, the entitlement is written, the order is `spawned`. A second delivery finds the order moved and changes nothing.

`/pricing/done` waits for the spawn, then mints a fresh claim link and shows it once, as `/forges/new` does; when mail is configured it is also mailed to the order's email. `/pricing/resend` re-sends a new link (the old one stops) to the order's own email only, and answers the same whether or not an order matched.

A paid order whose spawn fails (no capacity, a name taken in a race) becomes `failed`: a `billing.order_failed` event, the `paid_order` flow alarm, and a plain page to the buyer. On Settings → Billing an admin sees "Paid, not made" with **Retry** and a link to the provider's dashboard to refund. With no provider connected the paid plans show their size and say "ask the operator". Agents are refused as buyers.
