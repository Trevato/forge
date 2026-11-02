# Platform inventory — what the forge still takes from open-platform (#7667)

Owner, 2026-11-02: "this does go hand in hand with wanting everything to be
forge native now and getting off of the platform and the forge to forge
origin connections."

This page lists each thing the forge and its apps still take from the
platform (the Kubernetes cluster, Forgejo at git.open-platform.sh, Flux,
Kyverno, the Cloudflare edge, the droplet on pg-grand), what replaces it,
what is already done, and the issue that does the next step. It is written
from this repository. What lives only in the cluster or in the gitops
repository (`trevato-apps/gitops`) cannot be read from here and is marked
**unread**; #8948 reads it.

**Nothing is turned off or removed by this page or by any step it names
without the owner present. The forge never goes dark.** Every step has its
rollback written in its issue, and the platform stays up until the last
step (#8952).

## What #1432 retired, and what it did not

#1432 (the forge deploys itself) is closed. What it delivered, on main:

- `releaseOnLand` checks every landed tree out to `releases/<sha>/` and
  preflights it (`src/checks/landing.ts`); the keeper cuts, swaps in place
  with SO_REUSEPORT, verifies under load and swaps back by name
  (`src/keeper/`, `src/release/`; `docs/features/ship-itself.md`).
- A swap needs no image, no registry, no Forgejo and no Kubernetes roll.

What it did **not** retire, because production does not run it yet:

- Production is not switched to `FORGE_RELEASE_KEEPER=swap`
  (`FORGE_REPO`, `FORGE_SELF_SWAP=1`); the swap has not run on a hosted
  child with measured dark seconds (#8374 closed on the question, the drill
  is #8940). Releases still go through a `v*` tag, the Forgejo release
  workflow, an image on the platform registry, a chart, and Flux/standby
  reconcile rolling the pod.
- The path is still in the tree: `.forgejo/workflows/release.yml`, the
  Dockerfile's `VERSION`/`COMMIT` stamping, `keeper/deploy.ts`
  `kubeDeployer`, `scripts/cut-release.ts`' image half.
- The droplet's `forge-release-tick` (pg-grand) and the steward's Mac
  `tick release` still exist (**unread** here: only named in
  `docs/features/ship-itself.md` and `release-keeper.md`).

## The inventory

| # | The forge takes from the platform | Replaced by | Done already | Next step |
|---|---|---|---|---|
| 1 | **Image build and registry.** `release.yml` builds on the droplet runner, signs with cosign, pushes image and chart to the Forgejo registry (`forgejo-http.forgejo.svc.cluster.local:3000`). | Self-swap: the tree is the release; no image. | Code on main (#8042, #8054); runs in tests. | Drill on a child (#8940); switch production (#8941); delete the path after a week (#8942). |
| 2 | **Gitops and reconcile.** `trevato-apps/gitops` `apps/forge/prod/manifests.yaml`, `signup-gate.yaml`, `outsider-gate.yaml`; Flux; Kyverno; the standby reconcile on pg-grand (~15 min) which also resets the forge container's `image`. | A unit file and settings in the forge (env, limits, gates are forge settings); no reconcile. | Nothing: **unread** from here. | Read it into the forge and table every object (#8948). The reconcile stops owning `image` first (precondition of #8941). |
| 3 | **The pod and its supervisor.** A Deployment on local-path storage, `maxSurge 1`, restarts, a service account for the keeper's Deployment patch. | A box of the forge's own running `bun run src/main.ts` under systemd (`Restart=always`); `release/launch.ts` supervises swaps. Keeper #8374 proved the swap, not the box. | `docs/EXTRACT.md` steps 1–3, `docs/RESTORE.md`, `release/launch.ts`, `good.json`. | A box beside production taking no traffic (#8945). |
| 4 | **Ingress and TLS.** Cloudflare tunnel and cluster ingress carry `forge.open-platform.sh`, `*--forge.open-platform.sh` children and apps' own domains. | Caddy with a DNS-challenge wildcard and on-demand TLS asking `/__forge/domains/ask`, on the box. | Forge side done: `FORGE_TRUSTED_PROXIES`, `FORGE_CLIENT_IP_HEADER`, domains ask endpoint (`docs/DOMAINS.md`). | Staging name first, cutover runbook with rollback, the owner's go (#8946, after #8945). |
| 5 | **Identity.** `X-Plat-User` / `X-Plat-Edge-Token` (`src/http/edge.ts`): accounts the edge made have no password. | The forge's own password, passkey and OAuth between forges (#8902). `signin.edge` is the switch; an admin with neither is refused. | Switch exists (`docs/OPERATING.md`); `via: edge` is listed per account. | List edge-only accounts, a passkey for each, then switch off on a preview (#8947). |
| 6 | **Backup lanes.** The `backup` namespace's CronJobs (`FORGE_BACKUP_LANES`), `forgejo-dump` (suspended, 36 GB), the platform bucket's off-machine mirror. | The forge's own snapshot to its bucket and B2 (`docs/SNAPSHOT.md`), drilled weekly (`docs/RECOVERY.md`). | Snapshot, restore command, weekly drill, backup tile (`backup-truth.md`). | Decide the dump with the owner, a line for every lane, a restore with the platform unreachable (#8949, drill on #8945). |
| 7 | **Forgejo, where outside people send pulls.** grokbot's #42 to #67, `jmoran/forge-jay` (#8935), tdobbertin-espo's six (#8938) on git.open-platform.sh. | The forge: a real merge for a kept fork (#8935), a URL-to-landed-pull path for an agent (#6359), forge-to-forge origin (`docs/features/forge-origin.md`). | Origins and Bring exist (`docs/ORIGINS.md`). | Tell each person, then disable (not delete) new pulls on the Forgejo repository (#8950; waits for #6359, #8935). |
| 8 | **Hosted apps.** Apps the platform runs that are not on the forge. The list is in the cluster: **unread**. | Bring (paste a link) or Migrate; GitHub and Vercel go through #6007, not here. | Bring an app whole (#8919). | List with the owner's call per app (#8951). |
| 9 | **The droplet release tick.** `forge-release-tick` on pg-grand and the Mac's `tick release`. | The keeper (#1). | The keeper's code. | Switched off by the owner on the day #8942 records. |
| 10 | **Forgejo Actions jobs that are not releases.** `flake-hunt.yml`, `outside-gate.yml`, `sync-env.yml` on platform runners. | Scheduled jobs the forge runs, same verdicts. | `scripts/flake-hunt.ts`, checks and cells. | #8943. |
| 11 | **Previews of the forge's own repository.** `preview.yml` builds an image, signs it, pushes a chart. | A child forge in a cell (`src/spawn/placement.ts`, kind `cell`). | Apps preview from branch in a cell today. | #8944. |

## Order and the gate

Cuts are made one at a time, each with its rollback tested before the next.
The map holds the order: #8941 waits for #8940, #8942 for #8941, #8946 for
#8945, #8950 for #6359 and #8935. Every item above, and #8951, feeds the
last: **#8952**, which starts nothing until all the others are done, then:

1. The owner sets a quiet period (suggested 30 days).
2. The platform's access logs, read at the edge, show no request from the
   forge, its apps, its people or its agents for that period; the count is
   posted weekly.
3. A restore drill passed in that period that did not touch the platform
   (#8945, #8949).
4. A final snapshot of the platform's own state is in B2.
5. The owner says go. It is scaled to zero, not deleted, and kept a month.

## Outside agents

Outside agents work against the forge and are pointed there (#8950). The
route `trevato-apps/forge` on Forgejo closes only after #6359 gives them a
way in, and then pulls are disabled, never deleted, with rollback in
Forgejo's settings.

## Not here

Moving GitHub and Vercel in is #6007. No cut is started by this page.
