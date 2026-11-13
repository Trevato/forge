/**
 * The release keeper's ports, from a running forge (#7557): the forge's own
 * repository for main and the tags, the merge queue for "mid-landing", the
 * kube API for the Deployment, and the public URL for the probes.
 *
 * Two modes. `FORGE_RELEASE_KEEPER=on`, with `FORGE_REPO` naming a
 * repository here and the forge in a cluster, patches a Deployment: its name
 * and container are `FORGE_KEEPER_DEPLOYMENT` and `FORGE_KEEPER_CONTAINER`
 * (both default `forge`), and the pod's service account needs `get` and
 * `patch` on it.
 *
 * `FORGE_RELEASE_KEEPER=swap` (#8042) needs no cluster and wants
 * `FORGE_SELF_SWAP=1`: the keeper swaps main's tree in place (`swapper.ts`).
 */

import { join } from "node:path";
import type { App } from "../app.ts";
import { originPush } from "../actions/branches.ts";
import { serviceAccount } from "../cluster/jobs.ts";
import { getRepo, type Repo } from "../core/repos.ts";
import { createSession, destroySession } from "../core/sessions.ts";
import { getUserById, type User } from "../core/users.ts";
import { gatesInFlight } from "../checks/queue.ts";
import { migrationFiles, NUMBERED } from "../core/schema.ts";
import { runGit } from "../git/env.ts";
import { repoDir } from "../git/repos.ts";
import { ownProbeHeaders } from "../kernel/probe.ts";
import { bootStall } from "../perf/live.ts";
import { running } from "../kernel/version.ts";
import { compareVersions, readTags, recordFor } from "../release/shipped.ts";
import { checkoutRelease, preflightRelease } from "../release/checkout.ts";
import { handover } from "../release/swap.ts";
import { runningChildren } from "../boards/sampler.ts";
import { snapshotsOf } from "../snapshot/service.ts";
import { kubeDeployer } from "./deploy.ts";
import { inFlight, keepTimings } from "./record.ts";
import { swapper } from "./swapper.ts";
import type { KeeperPorts } from "./keeper.ts";
import { timedGet, verifyUnderLoad } from "./verify.ts";
import { phoneGate, probeCentre } from "./covered.ts";
import { diskUnder, roomy } from "../spawn/disk_floor.ts";

const LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const OID = /^[0-9a-f]{40}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const ZERO = "0".repeat(40);

export type KeeperEnv =
  | { on: true; mode: "kube"; deployment: string; container: string }
  | { on: true; mode: "swap" }
  | { on: false; why: string };

/** In swap mode a release is only the swap, so the cadence is a minute, not half an hour. */
export const SWAP_INTERVAL_MS = 60_000;

/** Whether the keeper runs, from the environment. */
export function keeperEnv(env: Record<string, string | undefined>): KeeperEnv {
  if (env.FORGE_RELEASE_KEEPER === "swap") {
    if (env.FORGE_SELF_SWAP !== "1") return { on: false, why: "FORGE_RELEASE_KEEPER=swap needs FORGE_SELF_SWAP=1" };
    return { on: true, mode: "swap" };
  }
  if (env.FORGE_RELEASE_KEEPER !== "on") return { on: false, why: "FORGE_RELEASE_KEEPER is not on" };
  if (!env.KUBERNETES_SERVICE_HOST) return { on: false, why: "not running in a cluster" };
  const deployment = env.FORGE_KEEPER_DEPLOYMENT || "forge";
  const container = env.FORGE_KEEPER_CONTAINER || "forge";
  if (!LABEL.test(deployment) || !LABEL.test(container)) return { on: false, why: "FORGE_KEEPER_DEPLOYMENT and FORGE_KEEPER_CONTAINER must be DNS labels" };
  return { on: true, mode: "kube", deployment, container };
}

/** The first active site admin that is a person: the account the page load signs in as. */
function anAdmin(app: App): User | undefined {
  const row = app.db
    .query<{ id: string }, []>(`SELECT id FROM user WHERE is_admin = 1 AND is_agent = 0 ORDER BY created_at LIMIT 1`)
    .get();
  return row === null ? undefined : getUserById(app.db, row.id);
}

/** The pages a release is verified under, one at a time: the ones people open. */
export function loadPages(repo: Pick<Repo, "ownerName" | "name">): string[] {
  return ["/boards", `/${encodeURIComponent(repo.ownerName)}/${encodeURIComponent(repo.name)}`, "/explore", "/"];
}

/** The pages looked at on a phone: home, the forge's repository, the apps page. */
export function phonePages(repo: Pick<Repo, "ownerName" | "name">): string[] {
  return ["/", `/${encodeURIComponent(repo.ownerName)}/${encodeURIComponent(repo.name)}`, "/apps"];
}

export function keeperPorts(app: App, input: { forgeUrl: string; deployment: string; container: string; swap?: boolean }): KeeperPorts | string {
  const named = app.config.forgeRepo;
  if (named === undefined) return "FORGE_REPO is not set";
  const [owner = "", name = ""] = named.split("/");
  const repo = getRepo(app.db, owner, name);
  if (repo === undefined) return `FORGE_REPO names ${named}, which is no repository on this forge`;
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const deployer =
    input.swap === true
      ? swapper({
          dataDir: app.config.dataDir,
          port: app.config.port ?? 0,
          treeRoot: join(import.meta.dir, "..", ".."),
          version: () => running().version,
          commit: () => running().commit,
          env: process.env,
          checkout: (sha) => checkoutRelease(app.config.dataDir, dir, sha),
          preflight: (tree) => preflightRelease(tree, app.config.dataDir),
          drain: () => handover.drain?.(),
          timed: (t) => {
            const flying = inFlight(app.db);
            if (flying !== undefined) keepTimings(app.db, flying.id, t);
          },
          probe: ownProbeHeaders(app.config.dataDir),
          ...(app.config.swapBudgetMs === undefined ? {} : { budgetMs: app.config.swapBudgetMs }),
        })
      : kubeDeployer({ credentials: serviceAccount(), deployment: input.deployment, container: input.container });
  const probeHeaders = ownProbeHeaders(app.config.dataDir);
  const at = (version: string) => runGit(["rev-parse", "--verify", "--quiet", `refs/tags/v${version}^{commit}`], { cwd: dir });
  return {
    ...(input.swap === true ? { minIntervalMs: SWAP_INTERVAL_MS } : {}),
    db: app.db,
    bus: app.bus,
    repo: { id: repo.id, ownerId: repo.ownerId },
    now: () => Date.now(),
    live: () => running().version,
    bootStallMs: () => bootStall.worst(),
    async main() {
      const head = await runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${repo.defaultBranch}^{commit}`], { cwd: dir });
      return head.ok && OID.test(head.value) ? head.value : undefined;
    },
    async newest() {
      const tags = await readTags(dir);
      if (!tags.ok) return undefined;
      const top = [...tags.value].filter((t) => VERSION.test(t.version)).sort((a, b) => compareVersions(b.version, a.version))[0];
      if (top === undefined) return undefined;
      const sha = await at(top.version);
      return sha.ok && OID.test(sha.value) ? { version: top.version, sha: sha.value } : undefined;
    },
    gating: gatesInFlight,
    snapshotting: () => snapshotsOf(app)?.takingMs(),
    crewRuns: () => runningChildren(app.db).agents,
    diskUsed: () => {
      const disk = diskUnder(app.config.dataDir);
      return disk === undefined || !(disk.totalBytes > 0) || roomy(disk) ? undefined : 1 - disk.freeBytes / disk.totalBytes;
    },
    deployer,
    async tag(version, sha) {
      if (!VERSION.test(version) || !OID.test(sha)) return "not a version and a commit";
      // The record `scripts/cut-release.ts` writes. The migrations are this process's: the keeper cuts only
      // when main has moved past a live tag, and each forge cuts the code it was built from at the earliest.
      const record = JSON.stringify(recordFor(version, migrationFiles, NUMBERED));
      const made = await runGit(["tag", "--annotate", "--file=-", `v${version}`, sha], {
        cwd: dir,
        stdin: `${record}\n`,
        env: { GIT_COMMITTER_NAME: "release keeper", GIT_COMMITTER_EMAIL: "keeper@forge.invalid" },
      });
      if (!made.ok) return made.error.stderr || "git refused the tag";
      const tagOid = await runGit(["rev-parse", `refs/tags/v${version}`], { cwd: dir });
      const owner = getUserById(app.db, repo.ownerId);
      // A swap needs no origin: the tag is the forge's own record of the release.
      if (!tagOid.ok || owner === undefined || input.swap === true) return undefined;
      // A tag the origin did not take is taken back here too: the keeper drops the cut, and a
      // tag left behind would be the newest, never live, and stall the cadence.
      const untag = async (why: string) => (await runGit(["tag", "--delete", `v${version}`], { cwd: dir }), why);
      const push = await originPush(app, owner, repo);
      if (!push.ok) return untag(`the origin refused v${version}: ${push.error}`);
      if (push.value === undefined) return undefined;
      const sent = await push.value([{ ref: `refs/tags/v${version}`, oldOid: ZERO, newOid: tagOid.value }]);
      return sent.ok ? undefined : untag(`pushing v${version} to the origin failed: ${sent.error}`);
    },
    probe: () => timedGet(input.forgeUrl, () => probeHeaders)("/healthz", false),
    async verify(onProbe) {
      const admin = anAdmin(app);
      const session = admin === undefined ? undefined : createSession(app.db, admin.id);
      const cookie = session === undefined ? {} : { cookie: `forge_session=${session.token}` };
      try {
        const loaded = await verifyUnderLoad({
          get: timedGet(input.forgeUrl, (asAdmin) => (asAdmin ? cookie : probeHeaders)),
          now: () => Date.now(),
          sleep: (ms) => Bun.sleep(ms),
          pages: loadPages(repo),
          onProbe,
        });
        if (!loaded.ok) return loaded;
        // A 200 is not proof a person can use the page: look at a phone (#11855).
        const look = probeCentre(input.forgeUrl, session === undefined ? undefined : { name: "forge_session", value: session.token });
        return phoneGate(loaded, phonePages(repo), look);
      } finally {
        if (session !== undefined) destroySession(app.db, session.token);
      }
    },
  };
}
