/**
 * Anonymous spawn: a stranger (no account) may open `/forges/new` and
 * `POST /api/v1/forges` to start a child forge. The child forks the
 * parent's own code, follows it as upstream, and the stranger is
 * rate-limited. A model key is refused; the claim names the admin.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { usePlacement, useProbe } from "../src/spawn/door.ts";
import { Database } from "bun:sqlite";
import { ANON_SPAWNS_GLOBAL_PER_DAY, ANON_SPAWNS_PER_DAY, checkAnonSpawn, noteAnonSpawn, resetAnonSpawns } from "../src/spawn/rate.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { childDirOf } from "../src/actions/spawn.ts";
import { bootHostedChild } from "../src/spawn/host.ts";
import { ok } from "../src/kernel/result.ts";

describe("anonymous spawn", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let rw: string;
  let placed = 0;

  const post = (payload: unknown, token?: string) =>
    fetch(`${base}/api/v1/forges`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
    });
  // A spawn boots its child in the background (`void bootHostedChild`). Wait
  // for each boot once, so it neither competes with the next test for the
  // machine nor outlives the data directory. Only the first call per child
  // joins the boot in flight; a later one would start the child's apps again.
  const settled = new Set<string>();
  const settle = async (...names: string[]) => {
    for (const name of names) {
      if (settled.has(name)) continue;
      settled.add(name);
      await bootHostedChild(app, name);
    }
  };
  const getPage = () => fetch(`${base}/forges/new`);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-spawn-anon-"));
    app = createApp({ dataDir, port: 0, forgeRepo: "alice/forge-code" });
    resetAnonSpawns(app.db);
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "a@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error("user");
    rw = createToken(app.db, a.value.id, "rw", "rw").token;
    // The forge's own code, public, with history: what children fork.
    const code = await createRepo(app, a.value, { name: "forge-code", visibility: "public" });
    if (!code.ok) throw new Error("code repo");
    await commitToBranch(app, a.value, code.value, {
      message: "forge v1",
      files: [{ path: "src/main.ts", content: "console.log('forge')" }],
    });
    // A public app a stranger may copy, and a private one they may not.
    const pub = await createRepo(app, a.value, { name: "notes", visibility: "public" });
    if (!pub.ok) throw new Error("public repo");
    await commitToBranch(app, a.value, pub.value, {
      message: "seed",
      files: [{ path: "a.txt", content: "a" }],
    });
    const priv = await createRepo(app, a.value, { name: "diary", visibility: "private" });
    if (!priv.ok) throw new Error("private repo");
    useProbe(app, () => async () => true);
    usePlacement(app, {
      place: async (plan) => ok({ url: `https://${plan.name}.fake.test`, bodyId: `fake-${++placed}` }),
      retire: async () => ok(),
    });
  }, 30_000);

  afterAll(async () => {
    // Before the servers stop: stopping empties the child cache, and a
    // boot started after that would open a child nothing closes.
    await settle("kid", "kid2", "kid3", "grown");
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("GET /forges/new renders for a stranger (not 404)", async () => {
    const res = await getPage();
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("New forge");
    // A stranger is not offered what does not apply to them.
    expect(html).not.toContain("For whom");
    expect(html).not.toContain("Model key");
  });

  test("anonymous dry-run plans: public apps only, no crew", async () => {
    const res = await post({ name: "kid", apps: ["alice/notes"] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.dryRun).toBe(true);
    expect(body.plan.apps.map((a: any) => a.ref)).toEqual(["alice/notes"]);
    expect(body.plan.briefs).toEqual([]);
    expect(placed).toBe(0);
    // A private app is "not a known app" to a stranger, as to anyone who
    // may not read it.
    const priv = await post({ name: "kid", apps: ["alice/diary"] });
    expect(priv.status).toBe(422);
  });

  test("anonymous may not send a crew or a model key", async () => {
    for (const bad of [
      { name: "kid", crew: ["scout"] },
      { name: "kid", modelKey: "sk-ant-api-123" },
    ]) {
      const res = await post(bad);
      expect(res.status).toBe(422);
      expect((await res.json()) as any).toEqual(
        expect.objectContaining({ error: "invalid" }),
      );
    }
  });

  test("anonymous spawn makes a child that forks the forge's code", async () => {
    const res = await post({ name: "kid", apps: ["alice/notes"], dryRun: false });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.dryRun).toBe(false);
    expect(typeof body.claimUrl).toBe("string");

    // Let its background boot finish before this test opens the same
    // directory (the two share the repo's git readers).
    await settle("kid");
    // The child's forge-code fork: the repo, its history, and the upstream.
    const { createApp: openChild } = await import("../src/app.ts");
    const child = openChild({ dataDir: childDirOf(app, body.bodyId) });
    try {
      const { getRepo } = await import("../src/core/repos.ts");
      const fork = getRepo(child.db, "kid", "forge");
      expect(fork).toBeDefined();
      const { repoDir } = await import("../src/git/repos.ts");
      const { runGit } = await import("../src/git/env.ts");
      const log = await runGit(["log", "--oneline"], {
        cwd: repoDir(child.reposRoot, "kid", "forge"),
      });
      expect(log.ok && log.value).toContain("forge v1");
      const parent = (await Bun.file(
        join(childDirOf(app, body.bodyId), "parent.json"),
      ).json()) as any;
      expect(parent.forgeCode).toEqual(
        expect.objectContaining({ repo: "kid/forge", upstream: "alice/forge-code", mode: "take-updates" }),
      );
    } finally {
      child.close();
    }
  });

  test("the rate limit holds a stranger to three spawns a day", async () => {
    // One spawn already made above; two more are allowed, the fourth is not.
    for (const name of ["kid2", "kid3"]) {
      const res = await post({ name, dryRun: false });
      expect(res.status).toBe(201);
    }
    const res = await post({ name: "kid4", dryRun: false });
    expect(res.status).toBe(429);
    expect((await res.json()) as any).toEqual(
      expect.objectContaining({ error: "rate_limited" }),
    );
    // A dry run is free: the plan still comes back.
    const dry = await post({ name: "kid5" });
    expect(dry.status).toBe(200);
    resetAnonSpawns(app.db);
  });

  test("the counts survive a restart and a global cap holds", async () => {
    const req = new Request("http://x/", { headers: { "x-forwarded-for": "203.0.113.9" } });
    for (let i = 0; i < ANON_SPAWNS_PER_DAY; i++) noteAnonSpawn(app.db, req);
    expect(checkAnonSpawn(app.db, req).allowed).toBe(false);
    // A new connection to the same file still sees the counted spawns.
    const again = new Database(join(dataDir, "forge.db"));
    expect(checkAnonSpawn(again, req).allowed).toBe(false);
    again.close();
    // They age out after a day.
    expect(checkAnonSpawn(app.db, req, Date.now() + 86_400_001).allowed).toBe(true);
    resetAnonSpawns(app.db);
    for (let i = 0; i < ANON_SPAWNS_GLOBAL_PER_DAY; i++)
      noteAnonSpawn(app.db, new Request(`http://x/${i}`, { headers: { "x-forwarded-for": `198.51.100.${i}` } }));
    expect(checkAnonSpawn(app.db, req).allowed).toBe(false);
    resetAnonSpawns(app.db);
  });

  test("a signed-in spawn still works (regression)", async () => {
    // The anonymous children above are still booting; let them finish.
    await settle("kid", "kid2", "kid3");
    const res = await post({ name: "grown", apps: ["alice/notes"], dryRun: false }, rw);
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(typeof body.claimUrl).toBe("string");
    // The signed-in child forks the code too.
    await settle("grown");
    const { createApp: openChild } = await import("../src/app.ts");
    const child = openChild({ dataDir: childDirOf(app, body.bodyId) });
    try {
      const { getRepo } = await import("../src/core/repos.ts");
      expect(getRepo(child.db, "grown", "forge")).toBeDefined();
    } finally {
      child.close();
    }
    expect(await readdir(join(dataDir, "children")).catch(() => [])).toHaveLength(4);
  });
});
