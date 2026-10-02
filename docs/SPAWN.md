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

## Choices

- Following across forges is HTTPS git with scoped tokens, because hosted
  children have no SSH.
- The parent never reaches into a child; children report in with a signed
  heartbeat carrying counts and version only.
- A proposal can only create branches under `child/<name>/` and open pulls.
