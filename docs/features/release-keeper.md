# Release keeper

The release keeper (#7557) cuts, promotes, verifies and, when it has to,
rolls back the forge's own releases. It is plain code on the forge's own
timer, with no model, so releases keep going out when no one is at the
keyboard. It does what the steward's `release.sh`, `verify-after.sh` and
`verify-release.sh` did. The code is `src/keeper/`.

## What it does, each minute

1. **Cut on cadence** (`keeper/cadence.ts`). It cuts when all of these hold:
   - main has moved past the newest `v*` tag;
   - no keeper release is rolling or verifying;
   - the newest tag is live, or the keeper rolled it back;
   - no merge-queue gate is running;
   - 30 minutes have passed since the last cut;
   - no hold stands.

   Before anything moves, it records the known-good version and the exact
   image the Deployment runs. Then it makes the annotated tag
   `v<version>` (patch + 1) on main's head, with the same record
   `scripts/cut-release.ts` writes, and pushes the tag to the repository's
   origin when it has one. The cut is a tag, never a commit, so it voids no
   gate in flight (#6640). The row is written before the tag: if the forge
   stops between the two, the next tick sends the tag, and a refused tag
   drops the row (and the local tag) so nothing waits on a release that
   never left.
2. **Promote.** It sets the Deployment's forge container to
   `<same image repository>:<version>`. The chart rolls with
   `maxSurge 1, maxUnavailable 0`. If the image is not built yet, the new
   pod waits on its pull while the old one keeps serving. While the roll
   runs, the old forge probes `/healthz` through the public URL once a
   second and counts every probe that got no 200.
3. **Verify under page load** (`keeper/verify.ts`). The new forge sees
   that it is the version in flight and spends 10 minutes on two things at
   once:
   - it fetches `/boards`, the forge's repository page, `/explore` and `/`,
     one at a time, signed in as the first site admin (a session made for
     the verify and deleted after it);
   - it probes `/healthz` once a second.

   A probe is bad when it is not a 200 or takes over 10 s. Three bad probes
   in a row fail the release.
4. **Verified live**, or **roll back and hold**. On a failure, the keeper
   first writes a hold with the version, the reason and the probe numbers.
   Then it sets the Deployment to the known-good image recorded at the cut,
   by name (`keeper/rollback.ts`). There is no "undo to previous": on
   2026-10-27 a `rollout undo` put the broken version back for two minutes.
   A release that is not live 3 h after its cut is rolled back the same way.

Every step is an event on the outbox: `release.cut`, `release.released`,
`release.verified_live`, `release.rolled_back` and `release.held`.

**Seconds dark** counts the probe-seconds without a 200, through the roll
and the verify together. The target is 0. A release with any dark seconds
files one issue, `Release <version> was dark for <n> s`.

## Holds

- **A failed verify's hold** blocks every cut. Land a pull whose title or
  body says the hold by number (`release hold 3`). Naming the version alone
  (`0.7.284`) does not count: changelogs and revert notes mention it too.
  The keeper then cuts the fix, and the hold is lifted when that release
  verifies.
- **An owner's hold** is set with MCP `release_hold {reason}`, with the Hold form on the `/releases` card, or with `h` on the terminal screen, and lifted
  (`release_hold {lift: <id>}`, the card's Lift button, `h` then `lift N`) — one function, `holdAs`/`liftAs`, behind all three.
  It needs a person who may roll back (MCP: on an admin-scope token); an agent never can.

## Where to see it

- The terminal: **Release keeper** in the command palette shows the same
  read as the card, for the same people.
- `/releases`: the **Release keeper** card says what holds the next cut and
  lists each release with its stage, the known-good version, the roll's
  non-200s, the probes and pages, the worst latency and the seconds dark.
- The **Maintenance** board (`/boards`, from the `keeperReleases` source)
  charts seconds dark and worst latency per release, and releases by
  outcome.
- MCP `release_keeper` returns the same data as JSON.

## Turning it on

The keeper is off unless all of these are true:

- `FORGE_RELEASE_KEEPER=on`;
- `FORGE_REPO` names a repository on this forge;
- the forge runs in a cluster.

`FORGE_KEEPER_DEPLOYMENT` and `FORGE_KEEPER_CONTAINER` name the Deployment
and its container (both default `forge`). The pod's service account needs
`get` and `patch` on that Deployment; the chart does not grant them. The
boot log says why it is off.

Guardrail: the keeper writes only a tag, the Deployment's image, its own
rows and issues. It has no account that may land a pull or push main.
Rollback is the one action it takes without a canary, because the image it
sets was already live.

Assumption: the keeper promotes by setting the image directly, as the
steward's rollback did. If Flux reconciles the image back, the keeper sets
it again on its next tick while the release is rolling. If it never takes,
the 3 h deadline rolls it back and holds.
