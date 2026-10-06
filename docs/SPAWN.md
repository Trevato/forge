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

Spawn mints one claim link (`src/spawn/claim.ts`): 32 random bytes, returned once as `claimUrl` in the `Spawned` result, kept in the child only as a sha256, single-use, and dead after 24 hours. The link is `https://<child>/claim#<token>`: the secret rides the fragment, which a browser never sends, so no server, edge or proxy log and no Referer sees it. `GET /claim` serves the form with nothing in it; a small script moves the code from the fragment into the form and drops it from the address bar (without JavaScript the code field takes a paste). Links in the older `/claim/<token>` form keep working until #937 removes them, no earlier than 24 hours after the first release that contains #836 (merged 2026-10-05) runs: links made before that may be in the path form, and a link lives 24 hours. `GET /claim` (or `/claim/:token`) shows the form and spends nothing, because a link unfurled in a chat app must not claim itself. `POST` (same-origin) makes the account, an admin and an owner of the child's organisation, burns the link in the same statement that checks it, and signs the person in. A used, expired or made-up link says which.

Any site admin of the parent, not only the one who spawned it, can re-issue the link of a child nobody has claimed: "Send a fresh link" on `/forges`, `POST /api/v1/forges/:name/claim-link`, or the MCP `claim_link`. The child keeps one claim row, so the new link replaces the old, which stops working at once. A claimed child is refused (409). The new link is shown once and never kept by the idempotency table.

A claim link is a live secret, so it stays out of an agent's conversation (#839). The MCP `spawn` makes the child and answers without `claimUrl`, saying where to get the link. The MCP `claim_link` changes nothing unless sent `reveal: true`. A person admin gets a fresh link on `/forges`, in their own browser, and hands it over. Both tools take `reveal: true` to put the link in the conversation on purpose, and the answer then says plainly that it is a live secret. Nothing on the parent stores a link to read later: a stored link would be one more place to take it from, and re-issuing already gives a fresh one.

A claim is bound to a spawned forge: it is read only from the organisation `parent.json` names, so a forge without `parent.json` answers 404, a row under any other account is never consulted, and a forge that already has an admin cannot be claimed. `keepAccess` (default false) decides who can see the child afterwards, and the claim page says which before anyone submits. With false, claiming removes the spawner's account from the organisation's Owners (the new owner can invite them back); with true, the page names the spawner and where to remove them. An idempotent replay of `POST /api/v1/forges` never returns or stores the link: `claimUrl` is kept as "shown once, in the first answer".

## The child's own keys, domain and model key (#576)

Spawn makes the child's `secret.key` and SSH host key in the child's own directory, so they exist before its first boot and are never the parent's. The child's address is `<name>.<parent's host>`, from the placement. It is recorded as `url` in `parent.json` and shown on the child's home ("Your forge: …"). Hosted by another forge, the child prints `FORGE_APP_SSH` verbatim wherever it says how to connect, and says the terminal is off when that is unset.

A spawner may give the child one credential: `modelKey`, an API-billed key (`sk-ant-api…`), with `budgetUsd`, a whole-life budget in dollars from 1 to 1000. A subscription token (`sk-ant-oat…`) is refused, because it is a person's own plan. The key never enters the plan, the dry run, the answer, the ledger or the idempotency table. In the child it is sealed with the child's own key as the account `starter` and granted to its organisation's crew. The budget is locked on that account (`lockBudget`): it is enforced where every run picks its account, whoever started the run and on whichever repository, and the child's admin cannot raise it, only add their own key. A retry with a different key is refused; a key is given once. Said plainly in every answer that carries a key (`keyNote`): the budget holds while this forge hosts the child, whose admin has no shell or database access; on a machine the child's owner controls, only a spend limit set at the provider binds the key, so use a key from a workspace with its own spend limit. The MCP `spawn` tool refuses `modelKey`, so a secret never passes through an agent's conversation. With no key the child is in a clean state: its pages say the crew has no model key yet and where an admin adds one.

## Choices

- Following across forges is HTTPS git with scoped tokens, because hosted
  children have no SSH.
- The parent never reaches into a child; children report in with a signed
  heartbeat carrying counts and version only.
- A proposal can only create branches under `child/<name>/` and open pulls.

## Callers

`POST /api/v1/forges {name, apps[], crew[], direction?, keepAccess?, modelKey?, budgetUsd?, dryRun}` (rw token, admin only) and the MCP `spawn` tool share `src/spawn/door.ts`. `dryRun` is true unless it is `false`: the answer is the plan and what is left behind, and nothing is made. `GET /api/v1/forges` lists the ledger's children. The child's org is its name; `crew` names the agents whose briefs travel. Errors: 401 unauthorized, 403 forbidden / cross_origin, 422 invalid, 409 refused / exists, 500 failed — each with one sentence. The MCP lets an `ro` token plan, never make.
