/**
 * Every app measures its visitors and page speed from its first deploy
 * (#2714): the template ships the forge's beacon, the forge answers
 * `/__forge/measure` on the app's host, and a report is stored against that
 * app and no other.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { scaffoldFiles } from "../src/apps/scaffold.ts";
import { appVisitors } from "../src/actions/apps.ts";
import { createToken } from "../src/core/tokens.ts";
import { getRepo } from "../src/core/repos.ts";
import { appVitals, recordAppVital } from "../src/apps/vitals.ts";
import { deleteApp, getAppByRepo } from "../src/core/apps.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const DOMAIN = "apps.test";

test("the template links the beacon and the beacon posts to the forge's door", () => {
  const files = new Map(scaffoldFiles({ name: "n", description: "d" }).map((f) => [f.path, f.content]));
  expect(files.get("static/beacon.js")).toContain('"/__forge/measure"');
  expect(files.get("static/beacon.js")).not.toContain('"/_measure"');
  expect(files.get("src/page.ts")).toContain('asset("beacon.js")');
});

describe("a report through the proxy", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-app-measure-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    servers = await serve(app);
    runtime = new AppsRuntime(app, {
      domain: DOMAIN,
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 1,
    });
    await runtime.start();
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    for (const name of ["notes", "diary", "busy", "wide", "secret"]) {
      const made = await newApp(app, a.value, {
        name,
        description: "A place for words",
        visibility: name === "secret" ? "private" : "public",
      });
      if (!made.ok) throw new Error(String(made.error));
      ids[name] = getAppByRepo(app.db, made.value.repo.id)!.id;
    }
  }, 120_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const report = (slug: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${servers.url}/__forge/measure`, {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: {
        host: `${slug}.${DOMAIN}`,
        origin: `http://${slug}.${DOMAIN}`,
        "user-agent": "test",
        ...headers,
      },
    });
  const good = { path: "/", ttfb: 40, load: 800, lcp: 600, inp: 90, cls: 0 };

  test("is stored against that app and no other, and the app's page counts it", async () => {
    expect((await report("notes", good)).status).toBe(204);
    const rows = app.db
      .query<{ app_id: string }, []>("SELECT app_id FROM app_vital")
      .all();
    expect(rows.map((r) => r.app_id)).toEqual([ids["notes"]!]);
    expect(appVitals(app.db, ids["notes"]!)).toMatchObject({
      today: 1,
      week: 1,
      loadP75: 800,
      inpP75: 90,
    });
    expect(appVitals(app.db, ids["diary"]!)).toMatchObject({ today: 0, week: 0 });
    // The body cannot name another app.
    expect((await report("notes", { ...good, app: ids["diary"] })).status).toBe(400);
  });

  test("its referrer and campaign are buffered against that app, as host and utm fields only (#9427)", async () => {
    const { flushViews } = await import("../src/perf/views_store.ts");
    await report("notes", { ...good, path: "/a?x=1", ref: "https://espodev.com/blog?secret=1", q: "?utm_source=post&utm_campaign=c1&token=zzz", out: "github.com" });
    flushViews(app.db);
    const row = app.db
      .query<Record<string, unknown>, [string]>("SELECT path, ref_host, source, campaign, out_host FROM traffic_view WHERE scope = ?1 ORDER BY id DESC LIMIT 1")
      .get(ids["notes"]!);
    expect(row).toEqual({ path: "/a", ref_host: "espodev.com", source: "post", campaign: "c1", out_host: "github.com" });
    expect(app.db.query("SELECT 1 FROM traffic_view WHERE scope = ?1").all(ids["diary"]!)).toEqual([]);
  });

  test("keeps no address and refuses a foreign origin, a bad body and an opted-out visitor", async () => {
    expect((await report("notes", good, { origin: "http://evil.test" })).status).toBe(403);
    expect((await report("notes", "nope")).status).toBe(400);
    expect((await report("notes", { ...good, load: -1 })).status).toBe(400);
    const before = app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM app_vital").get()!.n;
    expect((await report("notes", good, { dnt: "1" })).status).toBe(204);
    expect(app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM app_vital").get()!.n).toBe(before);
    const columns = app.db.query<{ name: string }, []>("PRAGMA table_info(app_vital)").all();
    expect(columns.map((c) => c.name).join()).not.toMatch(/ip|addr|agent/);
  });

  test("a private app refuses an anonymous report and stores nothing", async () => {
    const res = await report("secret", good);
    expect(res.status).toBe(404);
    expect(
      app.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM app_vital WHERE app_id = ?").get(ids["secret"]!)!.n,
    ).toBe(0);
  });

  test("the 31st report from one client is a 429", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await report("busy", good)).status);
    expect(statuses.slice(0, 30).every((s) => s === 204)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  test("the 601st report to one app in a minute is a 429, whoever sends it", async () => {
    let last = 0;
    for (let i = 0; i < 601; i++)
      last = (await report("wide", good, { "x-forwarded-for": `10.${i >> 8}.${i & 255}.1` })).status;
    expect(last).toBe(429);
  }, 60_000);

  test("the numbers are the admin's alone, on the API as on the page", async () => {
    const owner = (await import("../src/core/users.ts")).getUserByName(app.db, "alice")!;
    const repo = getRepo(app.db, "alice", "notes")!;
    expect(appVisitors(app, undefined, repo)).toBeUndefined();
    const bob = await createUser(app.db, { origin: "seed", trusted: true,
      username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
    if (!bob.ok) throw new Error(bob.error);
    expect(appVisitors(app, bob.value, repo)).toBeUndefined();
    expect(appVisitors(app, owner, repo)).toMatchObject({ today: 1 });
    expect(appVisitors(app, owner, repo)?.loadDays).toHaveLength(30);
    const get = (token?: string) =>
      fetch(`${servers.url}/api/v1/repos/alice/notes/app`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
    const anon = await get();
    expect(anon.status).toBe(200);
    expect(await anon.json()).not.toHaveProperty("vitals");
    const asBob = await get(createToken(app.db, bob.value.id, "r", "ro").token);
    expect(await asBob.json()).not.toHaveProperty("vitals");
    const asAlice = await get(createToken(app.db, owner.id, "r", "ro").token);
    expect(await asAlice.json()).toMatchObject({ vitals: { today: 1 } });
    expect(((await (await get(createToken(app.db, owner.id, "r2", "ro").token)).json()) as { vitals: { loadDays: unknown[] } }).vitals.loadDays).toHaveLength(30);
  });

  test("a sealed pull's preview refuses an anonymous report and stores nothing", async () => {
    const repo = getRepo(app.db, "alice", "diary")!;
    const alice = (await import("../src/core/users.ts")).getUserByName(app.db, "alice")!;
    app.db
      .query(
        `INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, sealed)
         VALUES ('sealed1', ?1, 99, 'pull', 't', '', ?2, 'open', 1)`,
      )
      .run(repo.id, alice.id);
    app.db
      .query("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES ('sealed1', 'main', 'x', 'a', 'b')")
      .run();
    const before = app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM app_vital").get()!.n;
    expect((await report("diary--99", good)).status).toBe(404);
    expect(app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM app_vital").get()!.n).toBe(before);
  });

  test("a body over the cap is a 413", async () => {
    const res = await report("diary", JSON.stringify({ ...good, path: "/" + "a".repeat(600) }));
    expect(res.status).toBe(413);
  });

  test("a preview's report is accepted but not stored", async () => {
    const before = app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM app_vital").get()!.n;
    expect((await report("diary--7", good)).status).toBe(204);
    expect(app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM app_vital").get()!.n).toBe(before);
  });
});

describe("what is kept", () => {
  const rows = (db: App["db"]) => db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM app_vital").get()!.n;
  let dataDir: string;
  let app: App;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-app-vitals-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
  });
  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const rep = (load: number) => ({ path: "/", ttfb: null, load, lcp: null, inp: null, cls: null }) as never;

  test("a day stops at dayMax rows per app", () => {
    const at = Date.UTC(2026, 0, 5, 12);
    expect(recordAppVital(app.db, "a1", rep(1), "c", "u", at, 2)).toBe(true);
    expect(recordAppVital(app.db, "a1", rep(1), "d", "u", at, 2)).toBe(true);
    expect(recordAppVital(app.db, "a1", rep(1), "e", "u", at, 2)).toBe(false);
    expect(recordAppVital(app.db, "a2", rep(1), "e", "u", at, 2)).toBe(true);
    expect(rows(app.db)).toBe(3);
  });

  test("p75 is right over several rows", () => {
    const at = Date.UTC(2026, 0, 6, 12);
    for (const [i, load] of [100, 200, 300, 400].entries())
      recordAppVital(app.db, "p", rep(load), `c${i}`, "u", at);
    const v = appVitals(app.db, "p", at);
    expect(v.loadP75).toBe(300);
    expect(v.today).toBe(4);
    expect(v.week).toBe(4);
  });

  test("every one of the five p75s reads back, and a missing one is undefined", () => {
    const at = Date.UTC(2026, 0, 7, 12);
    recordAppVital(app.db, "old5", { path: "/", ttfb: null, load: 5, lcp: null, inp: null, cls: 0 }, "z", "u", at);
    for (const [i, n] of [1, 2, 3, 4].entries())
      recordAppVital(
        app.db,
        "five",
        { path: "/", ttfb: n * 10, load: n * 100, lcp: n * 1000, inp: n * 20, cls: n / 10 },
        `c${i}`,
        "u",
        at,
      );
    expect(appVitals(app.db, "five", at)).toMatchObject({
      ttfbP75: 30,
      loadP75: 300,
      lcpP75: 3000,
      inpP75: 60,
      clsP75: 0.3,
    });
    const old = appVitals(app.db, "old5", at);
    expect(old.loadP75).toBe(5);
    expect(old.ttfbP75).toBeUndefined();
    expect(old.lcpP75).toBeUndefined();
    expect(old.clsP75).toBe(0);
  });

  test("the prune and the per-app reads use an index", () => {
    const plan = (sql: string) =>
      app.db.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join("\n");
    expect(plan("DELETE FROM app_vital WHERE at < 1")).toContain("app_vital_at");
    expect(plan("SELECT COUNT(*) FROM app_vital WHERE app_id = 'a' AND day = 'd'")).toContain("app_vital_app_day");
  });

  test("a 91-day-old row is gone after the next record, and deleting the app removes its rows", () => {
    const now = Date.UTC(2026, 5, 1, 12);
    recordAppVital(app.db, "old", rep(1), "c", "u", now - 91 * 86_400_000);
    recordAppVital(app.db, "old", rep(2), "d", "u", now - 89 * 86_400_000);
    recordAppVital(app.db, "old", rep(3), "e", "u", now);
    const n = (id: string) =>
      app.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM app_vital WHERE app_id = ?").get(id)!.n;
    expect(n("old")).toBe(2);
    deleteApp(app.db, "old");
    expect(n("old")).toBe(0);
  });
});
