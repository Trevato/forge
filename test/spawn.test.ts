import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { childDirOf, spawnForge, type SpawnDeps } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser, type User } from "../src/core/users.ts";
import { runGit } from "../src/git/env.ts";
import { repoDir } from "../src/git/repos.ts";
import { commitFiles } from "../src/git/write.ts";
import { hostedPlacement } from "../src/spawn/placement.ts";
import type { SpawnSource } from "../src/spawn/plan.ts";
import { Database } from "bun:sqlite";

const SECRET = "sk-live-SECRET-value";
const author = { name: "a", email: "a@x.invalid" };

let dir: string;
let app: App;
let alice: User;
let deps: SpawnDeps;
let source: SpawnSource;
const input = { name: "kid", org: "kids", apps: ["alice/notes"], carryBriefs: true, carrySubscriptions: false };

const post = (origin?: string) =>
  new Request("https://forge.test/spawn", { method: "POST", headers: origin ? { origin } : {} });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-spawn-"));
  app = createApp({ dataDir: dir, url: "https://forge.test" });
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@x.invalid", isAdmin: true });
  if (!made.ok) throw new Error("user");
  alice = made.value;
  const repo = await createRepo(app, alice, { name: "notes" });
  if (!repo.ok) throw new Error("repo");
  const d = repoDir(app.reposRoot, "alice", "notes");
  for (const n of ["one", "two"]) {
    const c = await commitFiles(d, { branch: "main", message: `add ${n}`, files: [{ path: `${n}.txt`, content: n }], author });
    if (!c.ok) throw new Error("commit");
  }
  app.db.run("UPDATE user SET password_hash = ?1 WHERE id = ?2", [SECRET, alice.id]);
  source = {
    catalog: [{ ref: "alice/notes", readable: true, bytes: 10, forgeJsonBytes: 0 }],
    briefs: [{ agent: "scout", text: "ship small" }],
    subscriptions: [],
  };
  deps = {
    placement: hostedPlacement({ host: "forge.test" }),
    request: post("https://forge.test"),
    url: new URL("https://forge.test/spawn"),
  };
});

afterEach(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const spawn = (patch: object = {}, d = deps, actor: User | undefined = alice) =>
  spawnForge(app, actor, { ...input, ...patch }, source, d);

async function allText(root: string): Promise<string> {
  let out = "";
  for (const e of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (e.isFile()) out += await Bun.file(join(e.parentPath, e.name)).text().catch(() => "");
  }
  return out;
}

describe("spawnForge", () => {
  test("apps arrive with their history, briefs arrive, the parent is named", async () => {
    const r = await spawn();
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const child = childDirOf(app, r.value.bodyId);
    const log = await runGit(["log", "--format=%s"], { cwd: repoDir(join(child, "repos"), "kids", "notes") });
    expect(log).toEqual({ ok: true, value: "add two\nadd one" });
    const db = new Database(join(child, "forge.db"), { readonly: true });
    expect(db.query("SELECT brief FROM agent").all()).toEqual([{ brief: "ship small" }]);
    db.close();
    expect(JSON.parse(await Bun.file(join(child, "parent.json")).text())).toEqual({
      apps: [{ repo: "kids/notes", upstream: "alice/notes" }],
      upstream: "https://forge.test",
      name: "kid",
      org: "kids",
      url: "https://kid--forge.test",
      keepAccess: false,
      size: "small",
      // A hash only: what the parent answers to stays in its own ledger.
      statusHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      // The child signs heartbeats to its parent with it (#425).
      beatKey: expect.stringMatching(/^[A-Za-z0-9_-]{20,}$/),
      // The plan's included credit, lent once (#11154).
      credit: { capUsd: 2, spentUsd: 0, token: expect.stringMatching(/^kid\./) },
    });
    // Its own plan, told once when it was made (#11141): a file of its own, never parent.json.
    expect(JSON.parse(await Bun.file(join(child, "plan.json")).text())).toMatchObject({ name: "Small", size: "small", status: "active" });
  });

  test("no secret arrives", async () => {
    const r = await spawn();
    if (!r.ok) throw new Error();
    const child = childDirOf(app, r.value.bodyId);
    expect(await allText(child)).not.toContain(SECRET);
    const db = new Database(join(child, "forge.db"), { readonly: true });
    expect(db.query("SELECT COUNT(*) AS n FROM token").get()).toEqual({ n: 0 });
    db.close();
  });

  test("a second call does not duplicate, and says one event", async () => {
    const a = await spawn();
    const b = await spawn();
    if (!a.ok || !b.ok) throw new Error();
    expect(b.value.bodyId).toBe(a.value.bodyId);
    expect(b.value.existed).toBe(true);
    expect(await readdir(join(dir, "children"))).toEqual([a.value.bodyId]);
    const events = app.db.query("SELECT COUNT(*) AS n FROM event WHERE kind = 'forge.spawned'").get();
    expect(events).toEqual({ n: 1 });
  });

  test("a half-made child is resumed, not duplicated", async () => {
    // First attempt dies after placing: the parent's repo vanishes mid-copy.
    const d = repoDir(app.reposRoot, "alice", "notes");
    await rename(d, `${d}.away`);
    const first = await spawn();
    expect(first.ok).toBe(false);
    expect(await readdir(join(dir, "children"))).toHaveLength(1);
    await rename(`${d}.away`, d);
    const second = await spawn();
    if (!second.ok) throw new Error(JSON.stringify(second.error));
    expect(second.value.existed).toBe(false);
    expect(await readdir(join(dir, "children"))).toEqual([second.value.bodyId]);
  });

  test("refuses an invalid plan again at the action", async () => {
    const r = await spawn({ name: "Bad Name" });
    expect(r).toMatchObject({ ok: false, error: { kind: "invalid", field: "name" } });
    const s = await spawn({ apps: ["alice/unknown"] });
    expect(s).toMatchObject({ ok: false, error: { kind: "invalid", field: "apps" } });
  });

  test("a signed-in person may spawn; a stranger may too; cross-origin may not", async () => {
    const bob = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "b@x.invalid" });
    if (!bob.ok) throw new Error();
    // Bob is not an admin; he may still spawn (self-serve). Dry-run path via action.
    const asBob = await spawn({}, deps, bob.value);
    // May fail later for missing apps in this fixture, but must not be forbidden.
    expect(asBob).not.toMatchObject({ error: { kind: "forbidden" } });
    // A stranger may spawn as well (anonymous self-serve): never unauthorized.
    expect(await spawnForge(app, undefined, input, source, deps)).not.toMatchObject({
      error: { kind: "unauthorized" },
    });
    const cross = { ...deps, request: post("https://evil.test") };
    expect(await spawn({}, cross)).toMatchObject({ error: { kind: "cross_origin" } });
  });
});
