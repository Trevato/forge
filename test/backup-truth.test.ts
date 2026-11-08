/**
 * Backups can't lie (#8742): a snapshot lost to a restart is taken again, the
 * bucket is judged from what is in it, a check that stops is red, a drill
 * that brought back nothing is red, and the database copy does not freeze
 * the serving thread.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { vitals } from "../src/kernel/vitals.ts";
import { backupVerdict, CHECK_LOG, CHECK_LOG_KEEP, CHECK_STALE_MS, recordRun, judge, keepReads, LATE_MS, readLane, watchBucket, type LaneRead } from "../src/snapshot/bucket.ts";
import type { DrillResult } from "../src/snapshot/drill.ts";
import { lastNightly, snapshotDue } from "../src/snapshot/due.ts";
import { snapshotsOf, startSnapshots } from "../src/snapshot/service.ts";
import { listSnapshots } from "../src/snapshot/snapshot.ts";
import { dirStore } from "../src/snapshot/store.ts";
import { verdictLines } from "../src/tui/screens/resilience.ts";
import { readHealth } from "../src/actions/health.ts";
import type { User } from "../src/core/users.ts";
import { NO_REACH } from "../src/flow/reach.ts";
import { kpiRowFor } from "../src/web/studio/kpi_row.ts";
import { vacuumInto } from "../src/snapshot/vacuum.ts";

let dataDir: string;
let app: App;
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-backup-truth-"));
  app = createApp({ dataDir, port: 0 });
});
afterAll(async () => {
  app.db.close();
  await rm(dataDir, { recursive: true, force: true });
});

const T = Date.parse("2026-11-02T12:00:00Z");
const lane = (newestAt: string | null, over: Partial<LaneRead> = {}): LaneRead => ({
  lane: "primary",
  where: "bucket/forge",
  offBox: true,
  newestAt,
  newestName: newestAt,
  newestBytes: 5_000_000,
  count: 3,
  readAt: new Date(T).toISOString(),
  ...over,
});
const drill = (over: Partial<DrillResult> = {}): DrillResult => ({
  at: "2026-11-01T09:00:00Z",
  snapshotId: "s",
  ms: 1,
  counts: { repositories: 4, issues: 9, users: 2, pulls: 1, apps: 1 },
  health: "ok",
  verdict: "green",
  failedStep: null,
  phases: [],
  budgetMs: 1,
  reason: null,
  ...over,
});
const fresh = (lanes: LaneRead[], at = T) => ({ lanes, checkedAt: new Date(at).toISOString() });

test("a snapshot is due when the newest finished before the last 08:00 slot, or there is none", () => {
  expect(new Date(lastNightly(T)).toISOString()).toBe("2026-11-02T08:00:00.000Z");
  expect(snapshotDue(undefined, T)).toBe(true);
  expect(snapshotDue("2026-11-01T08:55:00Z", T)).toBe(true);
  expect(snapshotDue("2026-11-02T08:55:00Z", T)).toBe(false);
  // Before today's slot, yesterday's is the one owed.
  expect(snapshotDue("2026-11-01T08:55:00Z", Date.parse("2026-11-02T07:00:00Z"))).toBe(false);
});

test("a newest snapshot over 26 h old is red; at 25 h it is green", () => {
  const at = (h: number) => new Date(T - h * 3_600_000).toISOString();
  const late = judge(fresh([lane(at(26.5))]), drill(), T);
  expect(late.state).toBe("red");
  expect(late.reasons.join(" ")).toContain("26 h old");
  const ok = judge(fresh([lane(at(25))]), drill(), T);
  expect(ok.state).toBe("green");
  expect(ok.line).toContain("4.8 MiB");
  expect(LATE_MS).toBe(26 * 3_600_000);
});

test("every lane is shown with its newest object, and one late lane makes it red", () => {
  const v = judge(fresh([lane("2026-11-02T08:50:00Z"), lane("2026-10-20T08:50:00Z", { lane: "mirror" })]), drill(), T);
  expect(v.lanes.map((l) => [l.lane, l.state])).toEqual([["primary", "green"], ["mirror", "red"]]);
  expect(v.state).toBe("red");
});

test("a lane that cannot be read, or holds nothing, is red", () => {
  expect(judge(fresh([lane(null, { error: "403" })]), drill(), T).state).toBe("red");
  expect(judge(fresh([lane(null)]), drill(), T).reasons[0]).toContain("holds no snapshot");
});

test("a check that has not run is red: the dead man's switch", () => {
  const stale = judge(fresh([lane("2026-11-02T08:50:00Z")], T - CHECK_STALE_MS - 60_000), drill(), T);
  expect(stale.state).toBe("red");
  expect(stale.reasons.join(" ")).toContain("has not run");
  const never = judge(undefined, drill(), T, T - CHECK_STALE_MS - 1);
  expect(never.state).toBe("red");
  // Just booted: not red yet, and not calm either — nothing is known.
  const booting = judge(undefined, drill(), T, T - 1000);
  expect(booting.reasons).toEqual([]);
  expect(booting.state).toBe("unknown");
  expect(booting.line).toBe("Backups not checked yet");
  expect(booting.note).toBe("not checked yet");
});

test("a drill that failed, or passed with no data back, is red", () => {
  const l = [lane("2026-11-02T08:50:00Z")];
  expect(judge(fresh(l), drill({ verdict: "red", failedStep: "open", health: "unreached" }), T).state).toBe("red");
  const empty = judge(fresh(l), drill({ counts: { repositories: 0, issues: 0, users: 0, pulls: 0, apps: 0 } }), T);
  expect(empty.state).toBe("red");
  expect(empty.drill?.says).toContain("no data");
  expect(judge(fresh(l), drill(), T).state).toBe("green");
});

test("a bucket read with no restore drill yet is unknown, never green, and raises no alarm", () => {
  const v = judge(fresh([lane("2026-11-02T08:50:00Z")]), undefined, T);
  expect(v.state).toBe("unknown");
  expect(v.unknowns.join(" ")).toContain("No restore drill");
  expect(v.reasons).toEqual([]);
});

test("a store's error keeps no credential, presigned query or userinfo", async () => {
  const secret = "SUPERSECRETKEY123";
  const bad = {
    ...dirStore(dataDir),
    where: "bucket/forge",
    names: () =>
      Promise.reject(new Error(`403 for https://u:p@s3.example.com/b/k?X-Amz-Signature=abcdef&X-Amz-Credential=AKIA now ${secret} ${secret}`)),
  };
  const r = await readLane("primary", bad, T, () => [{ endpoint: "https://s3.example.com", bucket: "b", accessKeyId: "AKIAX", secretAccessKey: secret }]);
  expect(r.error).not.toContain(secret);
  expect(r.error).not.toContain("abcdef");
  expect(r.error).not.toContain("u:p@");
  expect(JSON.stringify(judge(fresh([r]), drill(), T))).not.toContain(secret);
});

test("the terminal's Resilience dialog shows the verdict, the lanes and what is wrong", async () => {
  const w = watchBucket(dataDir, () => [], 3_600_000, 3_600_000);
  try {
    keepReads(dataDir, [lane(new Date(Date.now() - 40 * 3_600_000).toISOString())]);
    const lines = verdictLines({ app } as never).join("\n");
    expect(lines).toContain("Backups RED");
    expect(lines).toContain("primary");
    expect(lines).toContain("old");
  } finally {
    w.stop();
  }
});

test("vitals raises one backup card from the bucket, and none while it is fine", () => {
  const w = watchBucket(dataDir, () => [], 3_600_000, 3_600_000);
  try {
    const now = Date.now();
    keepReads(dataDir, [lane(new Date(now - 30 * 3_600_000).toISOString())], now);
    const v = vitals({ db: app.db, signals: app.signals, dataDir, now });
    expect(v.degraded.filter((d) => d.cause === "backup")).toHaveLength(1);
    expect(backupVerdict(dataDir, undefined, now + LATE_MS * 2).state).toBe("red");
    keepReads(dataDir, [lane(new Date(now - 3_600_000).toISOString())], now);
    expect(vitals({ db: app.db, signals: app.signals, dataDir, now }).degraded.some((d) => d.cause === "backup")).toBe(false);
  } finally {
    w.stop();
  }
});

test("readLane reads the store itself, and a store that fails is a red read, not a throw", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-lane-"));
  try {
    const empty = await readLane("primary", dirStore(dir));
    expect(empty.newestAt).toBeNull();
    expect(empty.count).toBe(0);
    const broken = await readLane("primary", { ...dirStore(dir), names: () => Promise.reject(new Error("boom")) });
    expect(broken.error).toContain("boom");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a restart with a snapshot lost mid-run takes one shortly after boot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-lost-"));
  const store = dirStore(dir);
  // What a release at 08:21 leaves: objects of a snapshot, and no manifest.
  await store.put("snapshots/2026-11-02T08-00-00Z/forge.db.0", new Uint8Array([1, 2, 3]));
  expect(await listSnapshots(store)).toHaveLength(0);
  const svc = startSnapshots(app, store, { version: "t", snapshotCatchUpMs: 20, bucketEveryMs: 3_600_000, bucketFirstMs: 3_600_000 });
  try {
    const until = Date.now() + 20_000;
    while ((await listSnapshots(store)).length === 0 && Date.now() < until) await Bun.sleep(50);
    expect((await listSnapshots(store)).length).toBe(1);
    // The bucket watch then reads it from the store.
    await svc.checkBucket();
    const v = backupVerdict(dataDir, undefined);
    expect(v.lanes[0]?.count).toBe(1);
    expect(snapshotsOf(app)).toBe(svc);
  } finally {
    await svc.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test("a boot with the night's snapshot in the store takes none; a day later it takes one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-kept-"));
  const store = dirStore(dir);
  const first = startSnapshots(app, store, { version: "t", nightly: false });
  const made = await first.now();
  await first.stop();
  const done = Date.parse(made.finishedAt);
  let clock = done + 1000;
  const svc = startSnapshots(app, store, { version: "t", nightly: false, now: () => clock });
  try {
    expect(snapshotDue(made.finishedAt, clock)).toBe(false);
    expect(await svc.takeIfDue()).toBe(false);
    expect(await listSnapshots(store)).toHaveLength(1);
    clock = done + 25 * 3_600_000;
    expect(snapshotDue(made.finishedAt, clock)).toBe(true);
    // Snapshot names are by wall second; wait one out so the second does not overwrite the first.
    await Bun.sleep(1100);
    expect(await svc.takeIfDue()).toBe(true);
    expect(await listSnapshots(store)).toHaveLength(2);
  } finally {
    await svc.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test("copying the database does not hold the serving thread (#7559)", async () => {
  const file = join(dataDir, "big.db");
  const db = new Database(file);
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE t (x BLOB)");
  const blob = new Uint8Array(100_000);
  db.transaction(() => {
    for (let i = 0; i < 1500; i++) db.query("INSERT INTO t VALUES (?1)").run(blob);
  })();
  const to = join(dataDir, "big-copy.db");
  // Inline, VACUUM INTO has finished before the call returns; off the thread, it has not begun.
  const done = vacuumInto(db, to);
  expect(existsSync(to)).toBe(false);
  await done;
  const copy = new Database(to, { readonly: true });
  expect(copy.query<{ n: number }, []>("SELECT count(*) AS n FROM t").get()?.n).toBe(1500);
  copy.close();
  db.close();
}, 60_000);

const runLines = (dir: string): string[] => readFileSync(join(dir, CHECK_LOG), "utf8").split("\n").filter(Boolean);

test("the check records each run; stopped past its interval, the verdict, tile, card, terminal and health are red saying when it last ran", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-check-runs-"));
  const own = createApp({ dataDir: dir, port: 0 });
  const w = watchBucket(dir, () => [{ lane: "primary", store: dirStore(dir) }], 3_600_000, 3_600_000);
  const realNow = Date.now;
  try {
    await w.pass();
    await w.pass();
    expect(runLines(dir)).toHaveLength(2);
    expect(JSON.parse(runLines(dir)[1]!).lanes[0].lane).toBe("primary");
    const ranAt = backupVerdict(dir, undefined).checkedAt!;
    expect(backupVerdict(dir, undefined).runs).toBe(2);
    // The check is stopped: nothing reads the bucket while the clock moves on.
    const later = Date.parse(ranAt) + CHECK_STALE_MS + 60_000;
    const v = backupVerdict(dir, drill(), later);
    expect(v.state).toBe("red");
    expect(v.reasons.join(" ")).toContain(`last ran ${ranAt}`);
    expect(v.checkLine).toContain("2 runs on record");
    const tile = kpiRowFor({ landedHours: Array(24).fill(0), landed: 0, live: null, builders: { running: 0, slots: 1, idle: null }, spend: { todayUsd: 0, ceilingUsd: null }, medianCheckMs: null, backupAt: null, backup: v, reach: NO_REACH }, null, new Date(later)).toString();
    expect(tile).toContain("attn");
    expect(tile).toContain("check stopped");
    expect(tile).toContain(`last ran ${ranAt}`);
    Date.now = () => later;
    const card = vitals({ db: own.db, signals: own.signals, dataDir: dir, now: later }).degraded.find((d) => d.cause === "backup");
    expect(card?.sentence).toContain(`last ran ${ranAt}`);
    const health = readHealth(own, { isAdmin: true } as User) as { ok: boolean; degraded: { cause: string; sentence: string }[] };
    expect(health.ok).toBe(false);
    expect(health.degraded.find((d) => d.cause === "backup")?.sentence).toContain(`last ran ${ranAt}`);
    expect(verdictLines({ app: own } as never).join("\n")).toContain("runs on record");
  } finally {
    Date.now = realNow;
    w.stop();
    own.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the run record is cut back to its keep once it holds twice as many, and a disk that refuses never throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-check-trim-"));
  try {
    for (let i = 0; i < CHECK_LOG_KEEP * 2; i++) recordRun(dir, `2026-11-02T00:00:${String(i % 60).padStart(2, "0")}Z`, [lane(null)]);
    expect(runLines(dir)).toHaveLength(CHECK_LOG_KEEP * 2);
    recordRun(dir, "2026-11-02T01:00:00Z", [lane(null)]);
    const kept = runLines(dir);
    expect(kept).toHaveLength(CHECK_LOG_KEEP);
    expect(JSON.parse(kept.at(-1)!).at).toBe("2026-11-02T01:00:00Z");
    // A data directory that is a file cannot be written to.
    const file = join(dir, "not-a-dir");
    writeFileSync(file, "x");
    expect(() => recordRun(file, "2026-11-02T02:00:00Z", [])).not.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
