/**
 * `GET …/app/pulls` (#10101): an adapter's recorded pull runs, newest first,
 * for readers of the repository; a stranger to a private repository gets 404.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { pullRunLines, recordPull } from "../src/apps/pull.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { promote } from "./helpers/members.ts";
import { tokenFor } from "./helpers/tokens.ts";

describe("app pulls API", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let aliceRo: string;
  let bobRo: string;

  const get = (path: string, token?: string) =>
    fetch(`${servers.url}${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : {});

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-app-pulls-api-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    await seedAdmin(app, { username: "alice", email: "alice@forge.local", password: "a-good-passphrase" });
    const b = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    promote(app.db, b.value);
    const alice = getUserByName(app.db, "alice")!;
    for (const [name, visibility] of [["hello", "public"], ["secret", "private"]] as const) {
      const made = await newApp(app, alice, { name, visibility } as never);
      if (!made.ok) throw new Error(String(made.error));
      const repo = getRepo(app.db, "alice", name)!;
      const appId = (app.db.query("SELECT id FROM app WHERE repo_id = ?1").get(repo.id) as { id: string }).id;
      recordPull(app.db, appId, { ok: true, pulled: 3, skipped: 1, errors: 0, cursor: "c1", durationMs: 42 });
      recordPull(app.db, appId, { ok: false, reason: "status 500 is not 2xx", durationMs: 7 });
    }
    aliceRo = tokenFor(app, "alice", "ro");
    bobRo = tokenFor(app, "bob", "ro");
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a reader gets the failed run then the good one, newest first", async () => {
    const res = await get("/api/v1/repos/alice/hello/app/pulls");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Record<string, unknown>[] };
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({ state: "failed", error: "status 500 is not 2xx", written: 0, cursor: null, durationMs: 7 });
    expect(body.items[1]).toMatchObject({ state: "ok", error: null, written: 3, skipped: 1, cursor: "c1", durationMs: 42, repeat: false });
    expect(typeof body.items[0]!.at).toBe("string");
  });

  test("limit narrows the list and is refused outside 1–100", async () => {
    const one = (await (await get("/api/v1/repos/alice/hello/app/pulls?limit=1")).json()) as { items: { state: string }[] };
    expect(one.items.map((i) => i.state)).toEqual(["failed"]);
    for (const bad of ["0", "101", "x", "-1"]) {
      expect((await get(`/api/v1/repos/alice/hello/app/pulls?limit=${bad}`)).status).toBe(422);
    }
  });

  test("the owner reads a private app's runs; a stranger and a guest get 404", async () => {
    const own = await get("/api/v1/repos/alice/secret/app/pulls", aliceRo);
    expect(own.status).toBe(200);
    expect(((await own.json()) as { items: unknown[] }).items).toHaveLength(2);
    expect((await get("/api/v1/repos/alice/secret/app/pulls", bobRo)).status).toBe(404);
    expect((await get("/api/v1/repos/alice/secret/app/pulls")).status).toBe(404);
  });

  test("a repository with no app, or none at all, is 404", async () => {
    expect((await get("/api/v1/repos/alice/nothing/app/pulls")).status).toBe(404);
  });

  test("pullRunLines clamps its limit", () => {
    const appId = (app.db.query("SELECT id FROM app LIMIT 1").get() as { id: string }).id;
    expect(pullRunLines(app.db, appId, 0)).toHaveLength(1);
    expect(pullRunLines(app.db, appId, 1000)).toHaveLength(2);
  });
});
