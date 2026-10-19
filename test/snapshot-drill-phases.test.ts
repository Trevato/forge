/**
 * A drill keeps how long each restore phase took and its budget (#2622):
 * green and red alike, round-tripped through the drill row, an older row
 * reading as no phases, and the Backups page showing the line escaped.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { formatSpan, runDrill, type DrillResult } from "../src/snapshot/drill.ts";
import { lastDrill, parsePhases, recordDrill } from "../src/snapshot/drills.ts";
import { restoreSnapshot } from "../src/snapshot/restore.ts";
import { startSnapshots, type SnapshotsHandle } from "../src/snapshot/service.ts";
import { takeSnapshot } from "../src/snapshot/snapshot.ts";
import { dirStore } from "../src/snapshot/store.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("drill phases", () => {
  let root = "";
  let app: App;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "forge-drillphases-"));
    app = createApp({ dataDir: root, port: 0 });
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
    await takeSnapshot(
      { db: app.db, dataDir: root, reposRoot: app.reposRoot, version: "t" },
      dirStore(join(root, "store")),
      new Date("2026-10-18T08:00:00Z"),
    );
  });
  afterAll(() => {
    app.close();
    rmSync(root, { recursive: true, force: true });
  });

  const drill = (restore: typeof restoreSnapshot, timeoutMs?: number) =>
    runDrill({
      store: dirStore(join(root, "store")),
      dataDir: join(root, "drill-data"),
      boot: async () => ({ ok: true, reason: "" }),
      restore,
      timeoutMs,
    });

  test("a green drill keeps the phases a stubbed restore reported, and the budget", async () => {
    const r = await drill((async (s: never, n: never, t: never, o: { onProgress?: (p: unknown) => void }) => {
      o.onProgress?.({ phase: "files", done: 0, total: 2, bytes: 0 });
      await sleep(30);
      o.onProgress?.({ phase: "files", done: 2, total: 2, bytes: 9 });
      o.onProgress?.({ phase: "unpack", done: 0, total: 1, bytes: 0 });
      await sleep(30);
      o.onProgress?.({ phase: "key", done: 0, total: 1, bytes: 0 });
      return restoreSnapshot(s, n, t, {});
    }) as never);
    expect(r.verdict).toBe("green");
    expect(r.budgetMs).toBeGreaterThanOrEqual(600_000);
    expect(r.budgetMs).toBeLessThan(601_000);
    expect(r.phases.map((p) => p.phase)).toEqual(["files", "unpack", "key"]);
    expect(r.phases[0]!.ms).toBeGreaterThanOrEqual(25);
    expect(r.phases[1]!.ms).toBeGreaterThanOrEqual(25);
  });

  test("a red drill keeps them too", async () => {
    const r = await drill(
      (async (_s: never, _n: never, _t: never, o: { onProgress?: (p: unknown) => void }) => {
        o.onProgress?.({ phase: "bundles", done: 1, total: 9, bytes: 1 });
        await new Promise(() => {});
      }) as never,
      300,
    );
    expect(r.verdict).toBe("red");
    expect(r.budgetMs).toBe(300);
    expect(r.phases.map((p) => p.phase)).toEqual(["bundles"]);
  });

  test("a stored row round-trips, and an older row reads as no phases", () => {
    const base: DrillResult = {
      at: "2026-10-18T09:00:00.000Z",
      snapshotId: "s",
      ms: 5,
      counts: { repositories: 1, issues: 2, users: 3, pulls: 4, apps: 5 },
      health: "ok",
      verdict: "green",
      failedStep: null,
      phases: [
        { phase: "files", ms: 58_000 },
        { phase: "bundles", ms: 290_000 },
      ],
      budgetMs: 840_000,
      reason: null,
    };
    recordDrill(app.db, base);
    expect(lastDrill(app.db)).toEqual(base);
    app.db.query("INSERT INTO drill (at, ms, repositories, issues, verdict) VALUES ('2026-10-19T00:00:00Z', 1, 0, 0, 'green')").run();
    const old = lastDrill(app.db)!;
    expect(old.phases).toEqual([]);
    expect(old.budgetMs).toBe(0);
  });

  test("stored JSON that is not phases reads as none", () => {
    for (const bad of ["x", "[]", '{"phases":[{"phase":"<b>","ms":1}],"budgetMs":5}', '{"phases":[{"phase":"files","ms":-1}],"budgetMs":5}', '{"phases":"a","budgetMs":5}'])
      expect(parsePhases(bad)).toEqual({ phases: [], budgetMs: 0 });
  });

  test("spans read as people say them", () => {
    expect(formatSpan(372_000)).toBe("6 min 12 s");
    expect(formatSpan(58_000)).toBe("58 s");
    expect(formatSpan(240_000)).toBe("4 min");
    expect(formatSpan(340)).toBe("340 ms");
  });
});

describe("the Backups page line", () => {
  let root = "";
  let app: App;
  let svc: SnapshotsHandle;
  let servers: Servers;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "forge-drillline-"));
    app = createApp({ dataDir: root, port: 0 });
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
    svc = startSnapshots(app, dirStore(join(root, "store")), { version: "t", nightly: false });
    servers = await serve(app);
  });
  afterAll(async () => {
    servers.stop();
    await svc.stop();
    app.close();
    rmSync(root, { recursive: true, force: true });
  });

  const kept = (over: Partial<DrillResult>): DrillResult => ({
    at: new Date().toISOString(),
    snapshotId: "snap-1",
    ms: 372_000,
    counts: { repositories: 1, issues: 1, users: 1, pulls: 0, apps: 0 },
    health: "ok",
    verdict: "green",
    failedStep: null,
    phases: [
      { phase: "files", ms: 58_000 },
      { phase: "unpack", ms: 20_000 },
      { phase: "bundles", ms: 290_000 },
      { phase: "key", ms: 1_000 },
    ],
    budgetMs: 840_000,
    reason: null,
    ...over,
  });
  const LINE = "6 min 12 s of its 14 min budget: files 58 s, unpack 20 s, bundles 4 min 50 s, key 1 s";
  const backups = async (): Promise<string> => {
    const r = await fetch(`${servers.url}/signin`, {
      method: "POST",
      headers: { origin: servers.url },
      body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
      redirect: "manual",
    });
    const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0]!;
    return (await fetch(`${servers.url}/settings/backups`, { headers: { cookie } })).text();
  };

  test("a green drill shows the time against the budget with each phase", async () => {
    recordDrill(app.db, kept({}));
    expect(await backups()).toContain(LINE);
  });

  test("a red drill shows it too, beside its reason", async () => {
    recordDrill(
      app.db,
      kept({
        verdict: "red",
        health: "unreached",
        failedStep: "restore",
        reason: "restore timed out in bundles <b>x</b>",
      }),
    );
    const html = await backups();
    expect(html).toContain("failed at");
    expect(html).toContain("restore timed out in bundles &lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain(LINE);
  });

  test("a drill with no phases shows no timing", async () => {
    for (const verdict of ["green", "red"] as const) {
      recordDrill(
        app.db,
        kept({
          verdict,
          failedStep: verdict === "red" ? "restore" : null,
          phases: [],
          budgetMs: 0,
        }),
      );
      const html = await backups();
      expect(html).toContain("snap-1");
      expect(html).not.toContain("budget:");
      expect(html).not.toContain("backups-timing");
    }
  });
});
