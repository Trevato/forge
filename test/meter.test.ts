/**
 * The meter: awake intervals and storage samples, and the two sums read
 * from them — awake seconds and GB-hours — checked against a hand count.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { dirBytes } from "../src/apps/bytes.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import type { AppRecord } from "../src/core/apps.ts";
import {
  beatAwake,
  closeAllAwake,
  closeAwake,
  openAwake,
  recordStorage,
  usageBetween,
} from "../src/core/meter.ts";
import { getRepoById } from "../src/core/repos.ts";
import { listDecisions, recordDecision } from "../src/core/decisions.ts";
import { listRuns } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";

const T = (hhmm: string): string => `2026-10-01T${hhmm}:00.000Z`;

interface MeterRow {
  repo_id: string;
  env: string;
  placement: string;
  started_at: string;
  beat_at: string;
  ended_at: string | null;
}
const usageOf = (
  app: App,
  repoId: string,
  from: string,
  to: string,
  now?: string,
) => usageBetween(app.db, from, to, now).find((u) => u.repoId === repoId);
const rows = (app: App, repoId: string): MeterRow[] =>
  app.db
    .query<MeterRow, [string]>(
      "SELECT * FROM meter WHERE repo_id = ? ORDER BY id",
    )
    .all(repoId);

describe("the meter ledger", () => {
  let dataDir: string;
  let app: App;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-meter-"));
    app = createApp({ dataDir, port: 0 });
  });
  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("start, sleep, wake, stop: the intervals sum to a hand count", () => {
    const at = (env: string, placement: "owned" | "cloud", t: string) =>
      openAwake(app.db, { repoId: "r1", env, placement, at: T(t) });
    at("production", "owned", "10:00"); // start
    at("production", "owned", "10:05"); // a redeploy: still the same interval
    closeAwake(app.db, { repoId: "r1", env: "production", at: T("10:30") }); // sleep
    at("production", "owned", "11:00"); // wake
    closeAwake(app.db, { repoId: "r1", env: "production", at: T("11:15") }); // stop
    at("pull-1", "cloud", "10:10");
    closeAwake(app.db, { repoId: "r1", env: "pull-1", at: T("10:20") });
    closeAwake(app.db, { repoId: "r1", env: "pull-1", at: T("10:40") }); // nothing open

    expect(rows(app, "r1").map((r) => [r.env, r.started_at, r.ended_at])).toEqual([
      ["production", T("10:00"), T("10:30")],
      ["production", T("11:00"), T("11:15")],
      ["pull-1", T("10:10"), T("10:20")],
    ]);
    // By hand: 30 + 15 minutes owned, 10 minutes cloud.
    const whole = usageOf(app, "r1", T("09:00"), T("12:00"), T("12:00"));
    expect(whole!.awakeByPlacement).toEqual({ owned: 45 * 60, cloud: 10 * 60 });
    expect(whole!.awakeSeconds).toBe(55 * 60);
    // [10:15, 11:05): 15 + 5 owned, 5 cloud.
    const part = usageOf(app, "r1", T("10:15"), T("11:05"), T("12:00"));
    expect(part!.awakeByPlacement).toEqual({ owned: 20 * 60, cloud: 5 * 60 });
    // An empty or backwards range is nothing.
    expect(usageBetween(app.db, T("12:00"), T("12:00"))).toEqual([]);
  });

  test("an open interval counts up to now, never past it, and shutdown closes it", () => {
    openAwake(app.db, { repoId: "r2", env: "production", placement: "owned", at: T("08:00") });
    const open = usageOf(app, "r2", T("00:00"), T("23:00"), T("08:20"));
    expect(open!.awakeSeconds).toBe(20 * 60);
    closeAllAwake(app.db, T("08:45"));
    expect(rows(app, "r2")[0]!.ended_at).toBe(T("08:45"));
    const closed = usageOf(app, "r2", T("00:00"), T("23:00"), T("23:00"));
    expect(closed!.awakeSeconds).toBe(45 * 60);
  });

  test("storage: bytes × hours / 1e9, a sample standing for its hour", () => {
    // 2 GB for an hour, then 1 GB until the next sample 30 minutes later,
    // then 4 GB for its full hour.
    recordStorage(app.db, { repoId: "r3", dataBytes: 1.5e9, repoBytes: 0.5e9, at: T("10:00") });
    recordStorage(app.db, { repoId: "r3", dataBytes: 1e9, repoBytes: 0, at: T("11:00") });
    recordStorage(app.db, { repoId: "r3", dataBytes: 3e9, repoBytes: 1e9, at: T("11:30") });
    const all = usageOf(app, "r3", T("00:00"), T("23:00"), T("23:00"));
    expect(all!.gbHours).toBeCloseTo(2 + 0.5 + 4, 9);
    // [10:30, 11:45): 2 GB × 0.5h + 1 GB × 0.5h + 4 GB × 0.25h.
    const part = usageOf(app, "r3", T("10:30"), T("11:45"), T("23:00"));
    expect(part!.gbHours).toBeCloseTo(1 + 0.5 + 1, 9);
    // Nonsense in, zero bytes recorded.
    recordStorage(app.db, { repoId: "r4", dataBytes: -5, repoBytes: Number.NaN, at: T("10:00") });
    const none = usageOf(app, "r4", T("00:00"), T("23:00"), T("23:00"));
    expect(none?.gbHours ?? 0).toBe(0);
  });

  test("a restart closes the interval the last forge left open, at its last heartbeat", async () => {
    openAwake(app.db, { repoId: "r5", env: "production", placement: "owned", at: T("09:00") });
    beatAwake(app.db, T("09:07"));
    // The forge dies here: no close. A new runtime boots over the same data.
    const runtime = new AppsRuntime(app, {
      domain: "apps.test",
      scheme: "http",
      forgeUrl: "http://localhost",
    });
    await runtime.start();
    await runtime.stop();
    const [row] = rows(app, "r5");
    expect(row!.ended_at).toBe(T("09:07"));
    const used = usageOf(app, "r5", T("00:00"), T("23:00"));
    expect(used!.awakeSeconds).toBe(7 * 60);
  });

  test("a fixture directory's bytes are its files' bytes, links not followed", async () => {
    const root = join(dataDir, "fixture");
    await mkdir(join(root, "a", "b"), { recursive: true });
    await writeFile(join(root, "one.txt"), "x".repeat(1000));
    await writeFile(join(root, "a", "two.bin"), new Uint8Array(4096));
    await writeFile(join(root, "a", "b", "three"), "");
    await writeFile(join(root, "a", "b", "four"), "four");
    const outside = join(dataDir, "outside");
    await writeFile(outside, new Uint8Array(1_000_000));
    await symlink(outside, join(root, "link"));
    expect(await dirBytes(root)).toBe(1000 + 4096 + 0 + 4);
    expect(await dirBytes(join(dataDir, "missing"))).toBe(0);
  });
});

describe("the runtime meters what it runs", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let record: AppRecord;
  const DOMAIN = "apps.test";

  async function until<T>(read: () => T | undefined, ms = 60_000): Promise<T> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const value = read();
      if (value !== undefined) return value;
      await Bun.sleep(50);
    }
    throw new Error("did not happen in time");
  }
  const production = () =>
    runtime.status(record).find((e) => e.env === "production");

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-meter-rt-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    runtime = new AppsRuntime(app, {
      domain: DOMAIN,
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      sleepAfterMs: { production: 600, preview: 600 },
      sweepEveryMs: 100,
      storageEveryMs: 200,
    });
    await runtime.start();
    const created = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!created.ok) throw new Error(created.error);
    const made = await newApp(app, created.value, {
      name: "metered",
      description: "Counted",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    record = made.value.app;
  }, 120_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("deploy, sleep, wake and stop each open or close an interval", async () => {
    const run = await until(() =>
      listRuns(app.db, record.repoId, { kind: "deploy", limit: 5 }).find(
        (r) => r.state === "ok",
      ),
    );
    // Asleep: the first interval runs from serving to the sweep that slept it.
    const asleep = await until(() =>
      production()?.state === "asleep" ? production() : undefined,
    );
    let ledger = rows(app, record.repoId);
    expect(ledger.length).toBe(1);
    expect(ledger[0]!.placement).toBe("owned");
    // The policy placed it (#509): one `place` decision per opened interval.
    const placed = listDecisions(app.db, record.repoId, { kind: "place" });
    expect(placed.length).toBe(1);
    expect(placed[0]!.answer).toBe("owned");
    expect(placed[0]!.state).toMatchObject({
      env: "production",
      reason: "Runs on owned metal; no cloud body: bursts queue.",
      target: { where: "owned", nodeLabel: "plat.sh/site=vxrail" },
      seen: { alwaysOn: true, cloudBody: false, ownedCapacity: null, spillAtOwnedUse: 0.85 },
    });
    // The decisions API filters to them with `kind=place`, a crew decision left out.
    recordDecision(app.db, { kind: "next", repoId: record.repoId, state: {}, answer: "x", p: 1, by: "rule", ms: 0 });
    const res = await fetch(`${servers.url}/api/v1/repos/alice/metered/decisions?kind=place`);
    expect(res.status).toBe(200);
    const listed = (await res.json()) as { decisions: { kind: string; answer: string }[] };
    expect(listed.decisions.map((d) => [d.kind, d.answer])).toEqual([["place", "owned"]]);
    expect(ledger[0]!.started_at).toBe(run.servingAt!);
    expect(ledger[0]!.ended_at).toBe(asleep.since!);

    // Woken, then stopped: a second interval, opened and closed.
    const woke = await runtime.wake(record, "production");
    expect(woke).toBeDefined();
    const since = production()!.since!;
    expect(rows(app, record.repoId)[1]!.ended_at).toBeNull();
    await runtime.stopEnv(record, "production");
    ledger = rows(app, record.repoId);
    expect(ledger.length).toBe(2);
    expect(ledger[1]!.started_at).toBe(since);
    expect(ledger[1]!.ended_at).not.toBeNull();

    // The sum read back is the sum of the intervals, by hand.
    const hand = ledger.reduce(
      (s, r) => s + (Date.parse(r.ended_at!) - Date.parse(r.started_at)) / 1000,
      0,
    );
    const used = usageOf(app, record.repoId, "2000-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z");
    expect(used!.repoId).toBe(record.repoId);
    expect(used!.awakeSeconds).toBeCloseTo(hand, 6);
    expect(used!.awakeSeconds).toBeGreaterThan(0);
  }, 90_000);

  test("storage is sampled: the repository's bytes, as counted on disk", async () => {
    const sample = await until(() =>
      app.db
        .query<{ repo_bytes: number; data_bytes: number }, [string]>(
          "SELECT repo_bytes, data_bytes FROM storage WHERE repo_id = ? ORDER BY id DESC",
        )
        .get(record.repoId) ?? undefined,
    );
    expect(sample.repo_bytes).toBeGreaterThan(0);
    const repo = getRepoById(app.db, record.repoId)!;
    // The repository does not change between the sample and this count.
    expect(sample.repo_bytes).toBe(
      await dirBytes(repoDir(app.reposRoot, repo.ownerName, repo.name)),
    );
  }, 30_000);
});

describe("closing the forge", () => {
  test("ends the open interval while the database is open and writes nothing after", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-meter-close-"));
    const lines: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    try {
      const app = createApp({ dataDir, port: 0 });
      const runtime = new AppsRuntime(app, {
        domain: "apps.test",
        scheme: "http",
        forgeUrl: "http://localhost",
        sweepEveryMs: 20,
      });
      await runtime.start();
      openAwake(app.db, { repoId: "r9", env: "production", placement: "owned", at: T("09:00") });
      app.close();
      // The sweeper would have beaten the meter by now, on a closed database.
      await Bun.sleep(80);
      await runtime.stop();
      expect(lines.filter((l) => l.includes("meter write failed"))).toEqual([]);
      const db = new Database(join(dataDir, "forge.db"), { readonly: true });
      const row = db
        .query<MeterRow, []>("SELECT * FROM meter WHERE repo_id = 'r9'")
        .get();
      db.close();
      expect(row!.ended_at).not.toBeNull();
    } finally {
      spy.mockRestore();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
