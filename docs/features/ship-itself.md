# The forge ships itself (#8042)

One path, in the forge: **landing → on cadence the keeper takes main's tree → preflight → swap in place → verify under load → known good, or swap back and hold.** No image, no registry, no Forgejo, no Kubernetes roll, no steward.

## Switch

`FORGE_REPO=<owner>/<name> FORGE_SELF_SWAP=1 FORGE_RELEASE_KEEPER=swap` (the conductor's one line), on a kernel with `net.ipv4.tcp_migrate_req=1` and with the SSH terminal off (`FORGE_SSH_PORT=0`) until it can be handed over. `FORGE_RELEASE_KEEPER=on` is the old Deployment-patch path and stays until production has moved.

## What happens

1. `releaseOnLand` checks each landed tree out to `releases/<sha>/` (`checks/landing.ts`).
2. Every minute (`SWAP_INTERVAL_MS`) the keeper (`keeper/keeper.ts`) compares main with the newest tag. `swapper.admits` refuses a cut that could not be swapped: SSH held, the kernel setting missing, a dependency added, a red `--preflight`. Nothing is tagged or recorded then, and the line says why.
3. The cut records the known good as `tree/<commit>:<version>`, tags `v<version>` in the forge's own repository only (no origin push, so Forgejo-side tools never see the cut), and `swapper.setImage` pins the running tree under `releases/<commit>/`, starts the new tree beside this process on the same port (`release/swap.ts`, SO_REUSEPORT, `FORGE_VERSION` and `FORGE_COMMIT` set), waits until health names its commit, and drains this process.
4. The new process finds a release in flight, spends ten minutes under page load (`keeper/verify.ts`) and either calls `verified` (the tree becomes the last good release) or sets the recorded known-good tree by name, which is the same swap, and holds.

## A pod restart

`release/launch.ts` is the container's first process. `keepGood` records a swapped tree with `base`, the image version it was swapped over, in `release/good.json`. When the same image restarts, the launcher starts that tree first, and a ready older image never replaces it as the last good. A different image version is a deliberate roll (a new base): it runs, and is kept over the swapped tree. A swapped tree that does not become ready in the grace gives way to the image and the rollback card says so. The swapped process is not the launcher's child, so it writes `release/serving.json` (`release/serving.ts`) and the launcher stays up while that pid lives and signals it on SIGTERM; when it dies the container exits and restarts on the newest good tree.

## Two writers, apps and runs

The handover is the existing one (#2040): the new process listens beside the old; the old stops accepting at once, stops its timers (throughput keeper, merge queue, deliveries), lets crew runs in flight finish and land, and closes after its in-flight requests. Runs hold leases that either process renews (`failAbandonedRuns` only fails a lapsed lease), apps are restarted by the new process and the old stops its own after the linger. The pause is measured, not assumed: during the roll the old process probes `/healthz` each second and counts non-200s into `keeper_release` (`roll_probes`, `roll_non200`, `seconds_dark`), shown on /releases; `test/release-keeper-swap.test.ts` drives a client through two swaps and asserts 0 refused requests where the kernel migrates queued connections.

## Dependencies

A release's directory has no `node_modules`, and installing into it before preflight would run a package manager's scripts inside the forge. So a tree whose package.json names any dependency is not swapped: the keeper does not cut it and says a new image is needed (the image is the base). Today `package.json` has none.

## Reading it

/releases, the terminal's Release keeper and MCP `release_keeper`: version, short commit, cut time, **landed to live** (merge of the landed pull to the new version answering), known good, probes, dark seconds. /changelog: the live line adds "Landed to live in …" for the release the forge runs.

## What can be deleted once production runs it

The image-per-release path (release workflow image build and push, the `Dockerfile` `VERSION`/`COMMIT` stamping per release), `keeper/deploy.ts` `kubeDeployer` and `FORGE_KEEPER_DEPLOYMENT`/`CONTAINER`, the promote scripts and `scripts/cut-release.ts`'s image half, the droplet's `forge-release-tick` on pg-grand, and the chart's service-account patch rule.
