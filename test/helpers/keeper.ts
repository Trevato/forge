/** A forge, its own repository and the release keeper's ports with a fake cluster and clock (#7557). */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/app.ts";
import { createRepo } from "../../src/core/repos.ts";
import { createUser } from "../../src/core/users.ts";
import { id } from "../../src/kernel/id.ts";
import type { Deployer } from "../../src/keeper/deploy.ts";
import type { KeeperPorts } from "../../src/keeper/keeper.ts";
import { verifyUnderLoad, type Probe } from "../../src/keeper/verify.ts";
import "./roomy-disk.ts";

export const A = "a".repeat(40);
export const B = "b".repeat(40);
export const C = "c".repeat(40);

/** A Deployment that remembers every image set on it. Its revision history holds a broken image "undo" would bring back. */
export function fakeDeployer(image: string) {
  const state = { image, set: [] as string[], history: ["reg.test/o/forge:0.7.277"] };
  const deployer: Deployer = {
    image: async () => state.image,
    async setImage(next) {
      state.history.push(state.image);
      state.image = next;
      state.set.push(next);
    },
  };
  return { deployer, state };
}

export async function keeperForge(opts: { healthz?: (n: number) => Probe } = {}) {
  const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "forge-keeper-")), port: 0, forgeRepo: "alice/forge" });
  const u = await createUser(app.db, { username: "alice", email: "a@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true, adminIfFirst: true });
  if (!u.ok) throw new Error("user");
  const repo = await createRepo(app.db, app.reposRoot, { ownerId: u.value.id, name: "forge", visibility: "public", description: "f" });
  if (!repo.ok) throw new Error("repo");
  const world = {
    now: Date.parse("2026-10-27T12:00:00.000Z"),
    live: "0.7.283",
    main: B,
    newest: { version: "0.7.283", sha: A } as { version: string; sha: string } | undefined,
    gating: 0,
    tags: [] as { version: string; sha: string }[],
    /** When set, the tag is refused with this line. */
    tagRefused: undefined as string | undefined,
    /** Why the next tag is refused; undefined lets it through. */
    refuseTag: undefined as string | undefined,
    healthz: opts.healthz ?? (() => ({ status: 200, ms: 12 })),
    pages: [] as string[],
  };
  const { deployer, state } = fakeDeployer("reg.test/o/forge:0.7.283");
  let probes = 0;
  const ports: KeeperPorts = {
    db: app.db,
    bus: app.bus,
    repo: { id: repo.value.id, ownerId: u.value.id },
    now: () => world.now,
    live: () => world.live,
    main: async () => world.main,
    newest: async () => world.newest,
    gating: () => world.gating,
    deployer,
    // As the forge's repository does: a tag made is the newest tag read back.
    async tag(version, sha) {
      if (world.refuseTag !== undefined) return world.refuseTag;
      world.tags.push({ version, sha });
      world.newest = { version, sha };
      return undefined;
    },
    probe: async () => world.healthz(probes++),
    verify: (onProbe) =>
      verifyUnderLoad({
        get: async (path) => {
          if (path === "/healthz") {
            const p = world.healthz(probes++);
            world.now += p.ms;
            return p;
          }
          world.pages.push(path);
          world.now += 40;
          return { status: 200, ms: 40 };
        },
        now: () => world.now,
        sleep: async (ms) => {
          world.now += ms;
        },
        pages: ["/boards", "/alice/forge", "/explore", "/"],
        onProbe,
      }),
  };
  /** A pull of the forge's repository, merged now. */
  const land = (n: number, title: string, body = "") => {
    const issueId = id();
    const at = new Date(world.now).toISOString();
    app.db.query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, ?3, 'pull', ?4, ?5, ?6, 'closed', ?7)`).run(issueId, repo.value.id, n, title, body, u.value.id, at);
    app.db.query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id, merged_at) VALUES (?1, 'main', ?2, '', '', ?3, ?4)`).run(issueId, `b/${n}`, repo.value.id, at);
  };
  const events = (kind: string) =>
    app.db.query<{ payload: string }, [string]>(`SELECT payload FROM event WHERE kind = ?1 ORDER BY id`).all(kind).map((e) => JSON.parse(e.payload) as Record<string, unknown>);
  return { app, user: u.value, repo: repo.value, world, ports, state, land, events };
}
