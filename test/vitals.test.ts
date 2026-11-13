/** The forge's standing: its shape, the admin gate, and what it flags. */

import { laneSentence } from "../src/kernel/vitals.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { accessDir, flushAccess, recordAccess } from "../src/http/access_log.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRun } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { vitals } from "../src/kernel/vitals.ts";
import { fetchInternal } from "../src/git/hook-address.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let admin = "";
let plain = "";
let repoId = "";

const post = (path: string, body: unknown, token?: string) =>
  fetch(servers.url + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
const mint = async (username: string, scope: string) =>
  (
    (await (
      await post("/api/v1/tokens", {
        adminConfirm: true,
        username,
        password: "a-good-passphrase",
        name: scope,
        scope,
      })
    ).json()) as { token: string }
  ).token;
/** A disk with room: no test but the disk's own depends on the machine's volume. */
const roomy = () => ({ freeBytes: 95, totalBytes: 100 });
const health = (token?: string) =>
  fetch(servers.url + "/api/v1/health", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-vitals-"));
  app = createApp({ dataDir, port: 0, disk: roomy });
  servers = await serve(app);
  await seedAdmin(app, { username: "alice", email: "alice@forge.local", password: "a-good-passphrase" });
  admin = await mint("alice", "ro");
  // Bob signs in and is no admin: his token, made directly, is a reader's.
  const bob = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "bob",
    email: "bob@forge.local",
    password: "a-good-passphrase",
  });
  if (!bob.ok) throw new Error(bob.error);
  plain = createToken(app.db, bob.value.id, "plain", "ro").token;
  repoId = (
    app.db.query("SELECT id FROM repo").get() as { id: string } | null
  )?.id ?? "";
  if (!repoId) {
    const owner = app.db.query("SELECT id FROM user LIMIT 1").get() as {
      id: string;
    };
    repoId = "repo-vitals";
    app.db
      .query("INSERT INTO repo (id, owner_id, name) VALUES (?1, ?2, 'r')")
      .run(repoId, owner.id);
  }
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a site admin with a read-only token gets the shape; others get the short one", async () => {
  const res = await health(admin);
  expect(res.status).toBe(200);
  const v = (await res.json()) as Record<string, any>;
  expect(Object.keys(v).sort()).toEqual(
    [
      "accessLog",
      "apps", "at", "checkedAt", "commit", "degraded", "disk", "draining", "errors", "flakes",
      "incidents", "lane", "memory", "needs", "ok", "queue", "rollout", "stale", "stuck",
      "version",
    ].sort(),
  );
  expect(v.disk.totalBytes).toBeGreaterThan(0);
  expect(v.memory.rssBytes).toBeGreaterThan(0);
  expect(v.apps).toEqual({ serving: 0, asleep: 0, previews: 0 });
  // A signed-in reader who is not an admin gets the platform's short shape,
  // never the numbers.
  expect(plain).not.toBe("");
  const res2 = await health(plain);
  expect(res2.status).toBe(200);
  const short = (await res2.json()) as Record<string, unknown>;
  expect(short["disk"]).toBeUndefined();
  expect(short["memory"]).toBeUndefined();
  expect(short["rollout"]).toBeDefined();
  // A stranger is told whether it is well, and no more (#2917).
  const stranger = (await (await health()).json()) as Record<string, unknown>;
  expect(Object.keys(stranger).sort()).toEqual(["commit", "draining", "ok", "version"]);
  expect((await fetch(servers.url + "/healthz")).status).toBe(200);
});

test("a full queue shows in queue, and an old one in needs", async () => {
  // Errors and refused calls are process-wide: another file in the shard may have left some.
  app.signals.errors.clear();
  app.signals.refused.clear();
  app.db.query("DELETE FROM run").run();
  const old = Date.now() - 3_600_000;
  for (let i = 0; i < 3; i++) createRun(app.db, { repoId, kind: "agent" });
  const v = vitals({ db: app.db, signals: app.signals, dataDir, disk: roomy });
  expect(v.queue).toEqual({ agent: 3 });
  // Process-wide signals (errors, refused calls) from other suites may speak too.
  expect(v.needs.join(" ")).not.toContain("queue");
  const later = vitals({ db: app.db, signals: app.signals, dataDir, disk: roomy, now: old + 2 * 3_600_000 + 3_600_000 });
  expect(later.ok).toBe(false);
  expect(later.needs.join(" ")).toContain("agent queue");
});

test("a running run with a lapsed lease is stuck, and needs says so", async () => {
  const run = createRun(app.db, { repoId, kind: "deploy", env: "production" });
  app.db
    .query(
      "UPDATE run SET state='running', started_at=?2, heartbeat_at=?2 WHERE id=?1",
    )
    .run(run.id, new Date(Date.now() - 10 * 60_000).toISOString());
  const v = (await (await health(admin)).json()) as ReturnType<typeof vitals>;
  expect(v.stuck.map((s) => s.runId)).toEqual([run.id]);
  expect(v.stuck[0]!.repo).toBe("alice/r");
  expect(v.ok).toBe(false);
  expect(v.needs.some((n) => n.includes("stuck"))).toBe(true);
  // A fresh heartbeat clears it.
  app.db
    .query("UPDATE run SET heartbeat_at=?2 WHERE id=?1")
    .run(run.id, new Date().toISOString());
  expect(vitals({ db: app.db, signals: app.signals, dataDir, disk: roomy }).stuck).toEqual([]);
});

test("the number of queries does not grow with runs", () => {
  const count = () => {
    let n = 0;
    const counting = new Proxy(app.db, {
      get(t, k) {
        const v = Reflect.get(t, k, t);
        if (k === "query") return (...a: any[]) => (n++, (v as any).apply(t, a));
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    vitals({ db: counting, signals: app.signals, dataDir, disk: roomy });
    return n;
  };
  const before = count();
  for (let i = 0; i < 40; i++) {
    const r = createRun(app.db, { repoId, kind: "check" });
    if (i % 2) app.db.query("UPDATE run SET state='running' WHERE id=?1").run(r.id);
  }
  expect(count()).toBe(before);
  // The queue, the running runs, the runs killed twice for their budget, the lane's depth and
  // finished checks, the red mains holding pulls' checks, the tests red on many pulls, (the checks
  // red on a full disk only while the disk is full), and the newest drill of every domain, the
  // checks no red main holds, the week's flake list, and the database's daily size readings
  // (#12010, at most 60 rows).
  expect(before).toBe(11);
});

test("errors are counted, bounded, redacted, and a burst is said", async () => {
  const { createLog, clearErrors, recentErrors, ERROR_RING } = await import(
    "../src/kernel/log.ts"
  );
  const { ERROR_BURST } = await import("../src/kernel/vitals.ts");
  const orig = console.error;
  console.error = () => {};
  try {
    clearErrors();
    const log = createLog("probe");
    log.error("upstream refused", { token: "ghp_abcdefghijklmnop1234567890" });
    const v = (await (await health(admin)).json()) as ReturnType<typeof vitals>;
    expect(v.errors.lastHour).toBe(1);
    expect(v.errors.latest[0]!.scope).toBe("probe");
    const text = JSON.stringify(v);
    expect(text).toContain("[redacted]");
    expect(text).not.toContain("ghp_abcdefghijklmnop1234567890");
    expect(v.needs.some((n) => n.includes("errors in the last hour"))).toBe(false);

    for (let i = 0; i < ERROR_RING + 50; i++) log.error(`boom ${i}`);
    const seen = recentErrors(1000);
    expect(seen.latest.length).toBe(ERROR_RING);
    expect(seen.lastHour).toBe(ERROR_RING + 51);
    expect(seen.lastHour).toBeGreaterThanOrEqual(ERROR_BURST);
    expect(vitals({ db: app.db, signals: app.signals, dataDir, disk: roomy }).needs.some((n) => n.includes("errors in the last hour"))).toBe(true);
    expect(vitals({ db: app.db, signals: app.signals, dataDir, disk: roomy, now: Date.now() + 2 * 3_600_000 }).errors.lastHour).toBe(0);
  } finally {
    console.error = orig;
    clearErrors();
  }
});

test("the lane: depth, the running check and its age, the median of the last finished, the time to clear", async () => {
  const { laneLine } = await import("../src/kernel/vitals.ts");
  app.db.query("DELETE FROM run").run();
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  // Empty lane: no line.
  expect(vitals({ db: app.db, signals: app.signals, dataDir, disk: roomy, now }).lane).toEqual({
    queued: 0, running: null, medianMinutes: null, clearsInMinutes: null,
  });
  expect(laneLine(vitals({ db: app.db, signals: app.signals, dataDir, disk: roomy, now }).lane, now)).toBeNull();
  // Three finished checks of 10, 20 and 30 minutes: the median is 20.
  for (const min of [10, 20, 30]) {
    const r = createRun(app.db, { repoId, kind: "check" });
    app.db
      .query("UPDATE run SET state='ok', started_at=?2, finished_at=?3 WHERE id=?1")
      .run(r.id, iso(now - 3_600_000), iso(now - 3_600_000 + min * 60_000));
  }
  const live = createRun(app.db, { repoId, kind: "check" });
  app.db
    .query("UPDATE run SET state='running', started_at=?2, heartbeat_at=?3 WHERE id=?1")
    .run(live.id, iso(now - 6 * 60_000), iso(now));
  for (let i = 0; i < 6; i++) createRun(app.db, { repoId, kind: "check" });
  const lane = vitals({ db: app.db, signals: app.signals, dataDir, disk: roomy, now }).lane;
  expect(lane.queued).toBe(6);
  expect(lane.running?.since).toBe(iso(now - 6 * 60_000));
  expect(lane.medianMinutes).toBe(20);
  expect(lane.clearsInMinutes).toBe(120);
  expect(laneLine(lane, now)).toBe(
    "6 checks queued · running a check for 6 min · median 20 min · clears in ~2 h",
  );
  // The same, in one call for an admin.
  const body = (await (await health(admin)).json()) as { lane: typeof lane };
  expect(body.lane.queued).toBe(6);
  expect(body.lane.medianMinutes).toBe(20);
  // Waiting past thirty minutes names the cause, not only the symptom.
  const later = vitals({ db: app.db, signals: app.signals, dataDir, disk: roomy, now: now + 3_600_000 });
  const cause = later.needs.find((n) => n.includes("one lane"));
  expect(cause).toMatch(/^6 checks wait behind one lane; the oldest since \d\d:\d\d; the lane runs nothing\.$/);
  expect(cause).not.toContain("Lane:");
});

test("an unauthenticated internal call is refused, logged and flagged; the probe is not", async () => {
  app.signals.refused.clear();
  const flagged = () =>
    vitals({ db: app.db, signals: app.signals, dataDir: app.config.dataDir, disk: roomy }).needs.filter((n) =>
      n.includes("internal call"),
    );
  const call = (path: string) =>
    fetchInternal(app.hookAddress.current, path, { method: "POST" });
  expect(flagged()).toEqual([]);
  expect((await call("/internal/ping")).status).toBe(403);
  expect(flagged()).toEqual([]);
  expect((await call("/internal/hook")).status).toBe(403);
  const [line] = flagged();
  expect(line).toContain("1 internal call");
  expect(line).toContain("/internal/hook");
  app.signals.refused.clear();
});

test("two forges in one process keep their own error and refusal signals", async () => {
  const { ERROR_BURST } = await import("../src/kernel/vitals.ts");
  const { createLog } = await import("../src/kernel/log.ts");
  const { noteRefusedInternal } = await import("../src/kernel/internal_refused.ts");
  // The forge's ledger takes every unowned logger's errors while it lives, so
  // anything another file in this process logged is in `app`'s: start empty.
  (await import("../src/kernel/log.ts")).clearErrors();
  app.signals.refused.clear();
  const dirB = await mkdtemp(join(tmpdir(), "forge-vitals-b-"));
  const other = createApp({ dataDir: dirB, port: 0, disk: roomy });
  try {
    const needs = (a: App) =>
      vitals({ db: a.db, dataDir: a.config.dataDir, signals: a.signals, disk: roomy }).needs;
    expect(needs(app)).toEqual([]);
    expect(needs(other)).toEqual([]);
    for (let i = 0; i < ERROR_BURST; i++) other.log.error("boom");
    noteRefusedInternal("POST", "/internal/hook", Date.now(), other.signals.refused);
    expect(needs(other).join(" ")).toContain("errors in the last hour");
    expect(needs(other).join(" ")).toContain("internal call");
    expect(needs(app)).toEqual([]);
    // A logger that belongs to no forge speaks for the whole process: production's path.
    const shared = createLog("shared");
    for (let i = 0; i < ERROR_BURST; i++) shared.error("boom");
    expect(needs(app).join(" ")).toContain("errors in the last hour");
    // A forge born later starts clean.
    const dirC = await mkdtemp(join(tmpdir(), "forge-vitals-c-"));
    const later = createApp({ dataDir: dirC, port: 0, disk: roomy });
    expect(needs(later)).toEqual([]);
    later.close();
    await rm(dirC, { recursive: true, force: true });
  } finally {
    other.close();
    await rm(dirB, { recursive: true, force: true });
    (await import("../src/kernel/log.ts")).clearErrors();
  }
});

test("degraded names each cause, stable, with when it began", async () => {
  const { createLog, clearErrors } = await import("../src/kernel/log.ts");
  const { ERROR_BURST, QUEUE_WAIT_MAX_MS } = await import("../src/kernel/vitals.ts");
  const orig = console.error;
  console.error = () => {};
  try {
    clearErrors();
    app.signals.refused.clear();
    const base = vitals({ db: app.db, signals: app.signals, dataDir, disk: roomy });
    expect(base.degraded.map((d) => d.cause)).not.toContain("errors");

    // queue: since is the oldest queued run's createdAt.
    app.db.query("DELETE FROM run").run();
    createRun(app.db, { repoId, kind: "agent" });
    const oldest = (
      app.db.query("SELECT MIN(created_at) AS m FROM run WHERE state='queued' AND kind='agent'").get() as { m: string }
    ).m;
    const later = Date.now() + 2 * QUEUE_WAIT_MAX_MS;
    const q = vitals({ db: app.db, signals: app.signals, dataDir, disk: roomy, now: later }).degraded.find((d) => d.cause === "queue:agent");
    expect(q?.since).toBe(new Date(oldest).toISOString());
    expect(q?.href).toBe("/settings/capacity");
    app.db.query("INSERT INTO forge_setting (key, value, updated_by, updated_at) VALUES ('crew.concurrency', '3', 'test', ?1)").run(new Date().toISOString());
    const busy = createRun(app.db, { repoId, kind: "agent" });
    app.db.query("UPDATE run SET state='running', started_at=?2, heartbeat_at=?2 WHERE id=?1").run(busy.id, new Date(later).toISOString());
    const held = vitals({ db: app.db, signals: app.signals, dataDir, disk: roomy, now: later }).degraded.find((d) => d.cause === "queue:agent");
    expect(held?.sentence).toBe("The agent queue has waited over 30 minutes: 1 queued, 1 of 3 slots running.");
    app.db.query("DELETE FROM run").run();
    app.db.query("DELETE FROM forge_setting WHERE key='crew.concurrency'").run();
    createRun(app.db, { repoId, kind: "agent" });
    createRun(app.db, { repoId, kind: "deploy", env: "production" });
    const d = vitals({ db: app.db, signals: app.signals, dataDir, disk: roomy, now: later }).degraded.find((x) => x.cause === "queue:deploy");
    expect(d?.sentence).toBe("The deploy queue has waited over 30 minutes: 1 queued, 0 running.");
    app.db.query("DELETE FROM run WHERE kind='deploy'").run();

    // stuck: one per run, keyed by run id, since is when it last moved.
    const run = createRun(app.db, { repoId, kind: "deploy", env: "production" });
    const moved = new Date(Date.now() - 10 * 60_000).toISOString();
    app.db
      .query("UPDATE run SET state='running', started_at=?2, heartbeat_at=?2 WHERE id=?1")
      .run(run.id, moved);
    const s = vitals({ db: app.db, signals: app.signals, dataDir, disk: roomy });
    const entry = s.degraded.find((d) => d.cause === `stuck:${run.id}`);
    expect(entry?.since).toBe(moved);
    expect(entry?.href).toBe(`/alice/r/runs/${run.id}`);
    expect(s.needs).toContain(entry!.sentence);
    app.db.query("UPDATE run SET state='ok' WHERE id=?1").run(run.id);

    // errors: no recorded start, so since is at; the cause is stable across calls.
    const log = createLog("probe");
    for (let i = 0; i < ERROR_BURST; i++) log.error(`boom ${i}`);
    const a = vitals({ db: app.db, signals: app.signals, dataDir, disk: roomy });
    const e = a.degraded.find((d) => d.cause === "errors");
    const later2 = vitals({ db: app.db, signals: app.signals, dataDir, disk: roomy, now: Date.now() + 5000 });
    expect(e?.since).toBe(app.signals.errors.recent(100).oldest!);
    expect(later2.degraded.find((d) => d.cause === "errors")?.since).toBe(e!.since);
    expect(e?.href).toBe("/settings/capacity#errors");

    // internal: refused calls.
    await fetchInternal(app.hookAddress.current, "/internal/hook", { method: "POST" });
    const i = vitals({ db: app.db, signals: app.signals, dataDir, disk: roomy }).degraded.find((d) => d.cause === "internal");
    expect(i?.href).toBe("/settings/capacity#internal");
    const i2 = vitals({ db: app.db, signals: app.signals, dataDir, disk: roomy, now: Date.now() + 5000 }).degraded.find((d) => d.cause === "internal");
    expect(i2?.since).toBe(i!.since);
    expect(i!.since).toBe(app.signals.refused.recent().oldest!);

    // a cause that clears is forgotten: when it returns it began again.
    const first = e!.since;
    clearErrors();
    expect(vitals({ db: app.db, signals: app.signals, dataDir, disk: roomy }).degraded.some((d) => d.cause === "errors")).toBe(false);
    for (let k = 0; k < ERROR_BURST; k++) log.error(`again ${k}`);
    const again = vitals({ db: app.db, signals: app.signals, dataDir, disk: roomy }).degraded.find((d) => d.cause === "errors");
    expect(again?.since).toBe(app.signals.errors.recent(100).oldest!);
    expect(again!.since > first).toBe(true);

    // a caller's `now` never moves a fallback start: it is the real clock's.
    const early = vitals({ db: app.db, signals: app.signals, dataDir, disk: roomy, diskFreeMin: 2, now: 1_000 });
    const d0 = early.degraded.find((d) => d.cause === "disk")!;
    expect(Date.parse(d0.since)).toBeGreaterThan(Date.parse("2020-01-01"));

    // every need has one matching sentence in degraded.
    const all = vitals({ db: app.db, signals: app.signals, dataDir, disk: roomy });
    expect(new Set(all.degraded.map((d) => d.sentence))).toEqual(new Set(all.needs));

    // the health API carries the same list.
    const h = (await (await health(admin)).json()) as { degraded: { cause: string }[] };
    expect(h.degraded.map((d) => d.cause)).toContain("errors");
  } finally {
    console.error = orig;
    clearErrors();
    app.signals.refused.clear();
  }
});

test("disk: since rests on first sight, holds across calls, resets after clearing", async () => {
  expect(vitals({ db: app.db, signals: app.signals, dataDir, disk: roomy }).degraded.some((d) => d.cause === "disk")).toBe(false);
  const a = vitals({ db: app.db, signals: app.signals, dataDir, disk: roomy, diskFreeMin: 2 }).degraded.find((d) => d.cause === "disk");
  expect(a?.href).toBe("/settings/capacity");
  await Bun.sleep(5);
  const b = vitals({ db: app.db, signals: app.signals, dataDir, disk: roomy, diskFreeMin: 2 }).degraded.find((d) => d.cause === "disk");
  expect(b?.since).toBe(a!.since);
  expect(vitals({ db: app.db, signals: app.signals, dataDir, disk: roomy }).degraded.some((d) => d.cause === "disk")).toBe(false);
  await Bun.sleep(5);
  const c = vitals({ db: app.db, signals: app.signals, dataDir, disk: roomy, diskFreeMin: 2 }).degraded.find((d) => d.cause === "disk");
  expect(c!.since > a!.since).toBe(true);
  vitals({ db: app.db, signals: app.signals, dataDir, disk: roomy });
});

test("since is said as a person would", async () => {
  const { needLine, sinceWords } = await import("../src/actions/health.ts");
  const now = Date.parse("2026-10-15T12:00:00Z");
  expect(sinceWords("2026-10-15T11:48:00Z", now)).toBe("12 min ago");
  expect(sinceWords("2026-10-15T08:00:00Z", now)).toBe("4 h ago");
  expect(sinceWords("2026-10-15T11:59:50Z", now)).toBe("just now");
  expect(sinceWords("2020-01-01T00:00:00.000Z", now)).toBe("2020-01-01");
  const line = needLine({ cause: "errors", sentence: "S.", since: "2020-01-01T00:00:00.000Z", href: "/x" }, now);
  expect(line).toBe("S. Since 2020-01-01.");
  expect(line).not.toContain("T00:00");
});

test("since is kept per forge: one forge's cause neither lends nor loses its start to another", async () => {
  const dirB = await mkdtemp(join(tmpdir(), "forge-vitals-since-"));
  const other = createApp({ dataDir: dirB, port: 0, disk: roomy });
  try {
    const disk = (a: App, diskFreeMin: number) =>
      vitals({ db: a.db, dataDir: a.config.dataDir, signals: a.signals, diskFreeMin, disk: roomy })
        .degraded.find((d) => d.cause === "disk");
    const first = disk(app, 2)!;
    expect(first).toBeDefined();
    await Bun.sleep(5);
    // The other forge has no disk cause: asking must not clear this one's start.
    expect(disk(other, 0)).toBeUndefined();
    expect(disk(app, 2)!.since).toBe(first.since);
    // And when it has the cause later, it starts then, not at the first forge's time.
    const later = disk(other, 2)!;
    expect(later.since > first.since).toBe(true);
  } finally {
    other.close();
    await rm(dirB, { recursive: true, force: true });
  }
});

test("a lane older than its budget is degraded with its cause; a silent run is stuck past three minutes", () => {
  app.db.query("DELETE FROM run").run();
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const live = createRun(app.db, { repoId, kind: "check" });
  app.db
    .query("UPDATE run SET state='running', started_at=?2, heartbeat_at=?3 WHERE id=?1")
    .run(live.id, iso(now - 31 * 60_000), iso(now));
  for (let i = 0; i < 3; i++) {
    const r = createRun(app.db, { repoId, kind: "check" });
    app.db.query("UPDATE run SET created_at=?2 WHERE id=?1").run(r.id, iso(now - (9 + i * 2) * 60_000));
  }
  // The oldest has waited 13 minutes: past the lane's ten.
  const v = vitals({ db: app.db, signals: app.signals, dataDir, disk: roomy, now });
  const lane = v.degraded.find((d) => d.cause === "queue:check");
  expect(lane?.sentence).toMatch(
    /^3 checks wait behind one lane; the oldest since \d\d:\d\d; the lane runs a check for 31 min \(limit 60\)\.$/,
  );
  expect(v.ok).toBe(false);
  // Five minutes in, the oldest is under its budget: nothing to say.
  app.db.query("UPDATE run SET created_at=?1 WHERE state='queued'").run(iso(now - 5 * 60_000));
  expect(vitals({ db: app.db, signals: app.signals, dataDir, disk: roomy, now }).degraded.map((d) => d.cause)).toEqual([]);
  // A run whose heart stopped four minutes ago is stuck, in words of the budget.
  app.db.query("UPDATE run SET heartbeat_at=?2 WHERE id=?1").run(live.id, iso(now - 4 * 60_000));
  const stuck = vitals({ db: app.db, signals: app.signals, dataDir, disk: roomy, now }).degraded.find((d) => d.cause === `stuck:${live.id}`);
  expect(stuck?.sentence).toBe(`Run ${live.id} is stuck: no heartbeat for 4 min (limit 3).`);
  app.db.query("DELETE FROM run").run();
});

test("only the disk need sees the disk: a 5% reading raises it, and nothing else does", () => {
  const low = () => ({ freeBytes: 5, totalBytes: 100 });
  const v = vitals({ db: app.db, signals: app.signals, dataDir, disk: low });
  expect(v.degraded.map((d) => d.cause)).toEqual(["disk"]);
  expect(v.needs).toEqual(["Disk is nearly full: 5% free."]);
  expect(vitals({ db: app.db, signals: app.signals, dataDir, disk: roomy }).needs).toEqual([]);
});

test("laneSentence says one lane for one slot and names the slots in force for several", () => {
  const now = Date.parse("2026-01-01T02:00:00Z");
  const oldest = "2026-01-01T01:04:00Z";
  const iso = (min: number) => new Date(now - min * 60_000).toISOString();
  const runs = [
    { pull: 4656, since: iso(5) },
    { pull: 4700, since: iso(2) },
  ];
  expect(laneSentence(3, oldest, [runs[0]!], 1, now)).toBe(
    "3 checks wait behind one lane; the oldest since 01:04; the lane runs #4656 for 5 min (limit 60).",
  );
  expect(laneSentence(11, oldest, runs, 2, now)).toBe(
    "11 checks wait for 2 slots, all busy; the oldest since 01:04; the longest running is #4656 at 5 min (limit 60).",
  );
  expect(laneSentence(1, oldest, [runs[1]!], 7, now, 2)).toBe(
    "1 check waits for 7 slots, 1 busy; the oldest since 01:04; the longest running is #4700 at 2 min (limit 60); 2 more held by a red main.",
  );
  expect(laneSentence(4, oldest, [], 3, now)).toBe(
    "4 checks wait for 3 slots, none busy; the oldest since 01:04; nothing runs.",
  );
});

test("an access log that cannot write is a need past five minutes; an idle forge is not (#6841)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vitals-access-"));
  const at = new Date();
  try {
    flushAccess();
    const later = (ms: number) =>
      vitals({ db: app.db, signals: app.signals, dataDir: dir, disk: roomy, now: Date.now() + ms });
    // ten idle minutes: nothing recorded, nothing to say
    const idle = later(600_000);
    expect(idle.degraded.some((d) => d.cause === "access-log")).toBe(false);
    expect(idle.accessLog.unwrittenSecondsAgo).toBeNull();
    // a recorded line whose append fails
    writeFileSync(accessDir(dir), "not a directory");
    recordAccess(dir, { request: new Request("http://forge.test/issues/a"), status: 200, ms: 1, client: "1.1.1.1" }, at);
    flushAccess(at);
    expect(later(0).degraded.some((d) => d.cause === "access-log")).toBe(false);
    const late = later(600_000);
    expect(late.degraded.find((d) => d.cause === "access-log")?.sentence).toContain("not writing");
    expect(late.accessLog.unwrittenSecondsAgo).toBeGreaterThan(300);
    // once a line lands the mark clears
    await rm(accessDir(dir));
    recordAccess(dir, { request: new Request("http://forge.test/issues/b"), status: 200, ms: 1, client: "1.1.1.1" }, at);
    flushAccess(at);
    expect(later(600_000).accessLog.unwrittenSecondsAgo).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
