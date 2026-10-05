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

Spawn mints one claim link (`src/spawn/claim.ts`): 32 random bytes, returned once as `claimUrl` in the `Spawned` result, kept in the child only as a sha256, single-use, and dead after 24 hours. `GET /claim/:token` on the child shows the form and spends nothing, because a link unfurled in a chat app must not claim itself. `POST` (same-origin) makes the account, an admin and an owner of the child's organisation, burns the link in the same statement that checks it, and signs the person in. A used, expired or made-up link says which.

A claim is bound to a spawned forge: it is read only from the organisation `parent.json` names, so a forge without `parent.json` answers 404, a row under any other account is never consulted, and a forge that already has an admin cannot be claimed. `keepAccess` (default false) decides who can see the child afterwards, and the claim page says which before anyone submits. With false, claiming removes the spawner's account from the organisation's Owners (the new owner can invite them back); with true, the page names the spawner and where to remove them. An idempotent replay of `POST /api/v1/forges` never returns or stores the link: `claimUrl` is kept as "shown once, in the first answer".

## Choices

- Following across forges is HTTPS git with scoped tokens, because hosted
  children have no SSH.
- The parent never reaches into a child; children report in with a signed
  heartbeat carrying counts and version only.
- A proposal can only create branches under `child/<name>/` and open pulls.

## Callers

`POST /api/v1/forges {name, apps[], crew[], direction?, keepAccess?, dryRun}` (rw token, admin only) and the MCP `spawn` tool share `src/spawn/door.ts`. `dryRun` is true unless it is `false`: the answer is the plan and what is left behind, and nothing is made. `GET /api/v1/forges` lists the ledger's children. The child's org is its name; `crew` names the agents whose briefs travel. Errors: 401 unauthorized, 403 forbidden / cross_origin, 422 invalid, 409 refused / exists, 500 failed — each with one sentence. The MCP lets an `ro` token plan, never make.
