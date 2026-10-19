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

## A client's forge in one form (#1608)

`/forges/new` is the whole path: a name, the owner's apps to fork, optionally one fresh app from a one-line description (`fresh`, at most 200 characters, one line), a budget with a model key; it ends in one claim link, shown once. Each picked app is a fork: its full history is copied and `parent.json` lists `apps: [{repo, upstream}]` so the child knows what it follows. A fresh app is a private repository in the child with a README, a `forge.json` and a tiny `index.ts` that answers `/` with the sentence, escaped; its name is the sentence's slug, never one of the forked names. A custom domain is not part of this: the child is reached at `<name>--<host>` and nothing else is promised. The same field is on `POST /api/v1/forges` and the MCP `spawn` (`fresh`). It is absent from the plan when unsaid, so older plan hashes are unchanged.

## Choices

- Following across forges is HTTPS git with scoped tokens, because hosted
  children have no SSH.
- The parent never reaches into a child; children report in with a signed
  heartbeat carrying counts and version only.
- A proposal can only create branches under `child/<name>/` and open pulls.

## Callers

`POST /api/v1/forges {name, apps[], crew[], direction?, keepAccess?, modelKey?, budgetUsd?, dryRun}` (rw token, admin only) and the MCP `spawn` tool share `src/spawn/door.ts`. `dryRun` is true unless it is `false`: the answer is the plan and what is left behind, and nothing is made. `GET /api/v1/forges` lists the ledger's children. The child's org is its name; `crew` names the agents whose briefs travel. Errors: 401 unauthorized, 403 forbidden / cross_origin, 422 invalid, 409 refused / exists, 500 failed — each with one sentence. The MCP lets an `ro` token plan, never make.

## The forge's own code, and the chain (#1085)

Every child is born with `<org>/forge`: a fork, with full history, of the
repository its parent forge is deployed from (`forgeRepo`; a spawned forge
has none configured, so it uses the fork it was born with). The child's owner
may change it freely. A grandchild forks the child's `forge`, so the chain
reads child → parent → … → root.

`parent.json` keeps `forgeCode`: `repo`, `upstream`, `mode`, `tip` (the
upstream's tip at birth) and `chain` (the ancestors' hops, copied from the
parent's own `parent.json`, so a grandchild reads the whole chain offline).
The spawner chooses `followMode` in the spawn input: `tell-me` (default) or
`take-updates`; it is part of the plan. `/:owner/forge/following` on the
child shows the chain, root first, one line per hop with its mode and how
many commits of its own it had when the next hop was born (the last hop is
counted now). What the modes do is in
"Following the parent forge" below.

Every door reads and cuts the chain the same way: the page
(`GET /:owner/forge/following`), `GET /api/v1/repos/:owner/forge/following`
(`chain`, `severedAt`), `POST …/following/sever` (rw token, owner only), the
MCP `following` and `sever` tools, and the terminal's **Chain** command.
Sever's one implementation is `severForge` in `src/actions/follow.ts`.

A child's heartbeat adds `forgeTip` and `severedAt` when it carries a fork;
`/family` on the parent shows `code at <tip>` or `follows nothing since …`.

## Following the parent forge

An hourly check (`CHECK_MS`, `src/spawn/upstream.ts`) fetches the parent's
code into the child's `forge` repository under `refs/upstream/*`. What it
learned (the parent's tip, how far behind the child is) is kept in
`upstream.json` under the app's data directory. Fetching changes no branch.

The owner's `followMode` decides what happens when the parent has new commits:

- `tell-me` sends one inbox card per new tip, listing its commits.
- `take-updates` opens one pull from the branch `forge/take-updates`
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
