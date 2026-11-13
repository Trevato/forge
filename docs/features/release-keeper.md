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
   - no snapshot is being taken, unless it has run two hours and is stuck
     (a release drains the process the snapshot runs in; #9653);
   - the disk under the forge's data is less than 80% full (a release
     writes a new tree beside the live one; at 80% the tick says
     "the disk is N% full; releases pause at 80% until room is made" and
     cuts on the first tick with room; #11686);
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
5. **Prune** (`keeper/prune.ts`, #11801). Once a release is verified live,
   the keeper removes the deployer's stored releases beyond the newest 15,
   never the live one or the release's named known-good, however old. Under
   the self-swap keeper these are the trees under `releases/<sha>/`; the
   commits removed are `pruned` on `release.verified_live` (with
   `pruneError` when the store refused, and the release stays verified).
   The Deployment-patch deployer keeps no store the forge can reach, so it
   prunes nothing: there the pg-grand host timer `forge-prune-images` is
   still the only pruner, until that deployer gets a store behind the same
   `ReleaseStore` port (#11914). If the live, running or known-good release names no
   stored one, it prunes nothing and says so in `pruneError`. Landing's own
   prune of `releases/` (keep `FORGE_RELEASES_KEEP`) never removes the
   keeper's newest release or its known-good tree. Removal runs inside the
   tick. Under the swap keeper only, this replaces `forge-prune-images`.

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

## A hotfix does not wait (#11839)

`release_now {reason}` (MCP, admin scope), the **Release now** form on the
`/releases` card: a person who may roll back (never an agent) asks for a cut at
the next tick. It skips the 30-minute spacing, a running merge queue and a
snapshot; it still waits for a release in flight to be proven, for a hold and
for room on the disk. The request lapses after an hour if main had nothing to
cut; the reason is kept on the release (`hotfix`) and shown on the card.

## Where the time went (#11839)

Each release row keeps its stage timings: cut to live, build (checkout of the
tree), proof (the preflight boot), switch (the new process taking the port) and
verify. The swap deployer measures build, proof and switch; a stage not
measured is left out. They show under the release on `/releases` and in
`release_keeper` (`stages`), which also answers `holding` (what the tick last
said stopped it: the disk guard, the spacing, a snapshot) and `releaseNow`.

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

## Switching it on in production (#7947)

Nothing here is switched on yet: production config is the conductor's, and a
run cannot reach it. The answers, from the code:

1. **Reconcile vs. keeper.** The keeper re-sends its image only while a
   release is `rolling`. Once it is verified, the ~15-minute standby
   reconcile (pg-grand) would set the older chart tag back. The fix is in
   gitops, not in a repair loop here: the reconcile must stop owning the
   forge container's `image`, so it never rolls the pod. The chart tag is
   then only the first image of a fresh Deployment.
2. **The image.** The keeper pushes `v<version>`; the Forgejo release job on
   git.open-platform.sh builds `<repo>:<version>`. While that build is held
   the new pod waits on its pull, the old pod serves
   (`maxSurge 1, maxUnavailable 0`), and the 3 h deadline (`ROLL_DEADLINE_MS`)
   rolls back by name and holds. Taking git.open-platform.sh off this path
   needs an in-cluster build Job started on the tag: a separate change.
3. **`FORGE_REPO`.** `release/own_tags.ts`, `/releases`, the behind watch and
   the landings read already run on it. `releaseOnLand`
   (`checks/landing.ts`) checks out and preflights each landed tree of that
   repository only, and swaps the process in only with `FORGE_SELF_SWAP=1`,
   which must stay unset in the cluster.
4. **The grant.** No manifest in this repository grants it (`charts/app` is
   the apps' chart). It is added in gitops.

The gitops change, in `trevato-apps/gitops` `apps/forge/prod/manifests.yaml`:

- `FORGE_RELEASE_KEEPER=on` (and `FORGE_REPO` set) on the forge container;
- a `Role` with `apiGroups: [apps]`, `resources: [deployments]`,
  `resourceNames: [forge]`, `verbs: [get, patch]`, and a `RoleBinding` to the
  pod's service account;
- the standby reconcile leaves the forge container's `image` alone.

For the conductor, in one line: set `FORGE_RELEASE_KEEPER=on`, grant the forge
service account get/patch on `deployments/forge`, and stop standby-reconcile
rendering the forge container's image.

Then the canary: watch one release cut, roll, verify and record on
`/releases`, 0 s dark. Only after that retire the steward's `tick release`
and its `launchd` job. Until then the Mac's tick stays.

Assumption: the keeper promotes by setting the image directly. Without the
gitops change above, a reconcile can set it back after the keeper says
verified; with it, nothing does. While a release is rolling the keeper sets
the image again each tick, and if it never takes, the 3 h deadline rolls it
back and holds.

## The first five minutes (#8848)

A release is judged on how it behaves right after boot, when every sweep whose
"last time" lives in memory runs once. The process keeps its worst event-loop
stall inside its first 5 minutes (`src/perf/boot_stall.ts`, fed by the loop lag
watch); the keeper writes it to the release row when the verify passes. `/releases`
and the terminal show it beside the release before it. Over 5 s the release stays
live (it answers) and a `failed` hold stands with the reason — the stall, the
limit, the last release's — until a pull saying `release hold N` lands and a
release verifies, as for any failed hold.

Cause of 0.7.339's 46 s: the review-repeat sweep (`flow/repeats.ts`, #8716) ran on
the first tick and grouped a week of findings against every group so far,
quadratically (51 s on the production-sized fixture of `test/boot-no-stall.test.ts`).
It now finds groups through a word index and hands the thread back between slices
(`kernel/breathe.ts`); the tick breathes between its passes.
