/** The forge's standing: its shape, the admin gate, and what it flags. */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRun } from "../src/core/runs.ts";
import { vitals } from "../src/kernel/vitals.ts";
import { fetchInternal } from "../src/git/hook-address.ts";
import { serve, type Servers } from "../src/http/server.ts";

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
const health = (token?: string) =>
  fetch(servers.url + "/api/v1/health", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-vitals-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  for (const username of ["alice", "bob"])
    await post("/api/v1/users", {
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
    });
  admin = await mint("alice", "ro");
  plain = await mint("bob", "admin");
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
      "apps", "at", "checkedAt", "commit", "degraded", "disk", "draining", "errors",
      "incidents", "lane", "memory", "needs", "ok", "queue", "rollout", "stale", "stuck",
      "version",
    ].sort(),
  );
  expect(v.disk.totalBytes).toBeGreaterThan(0);
  expect(v.memory.rssBytes).toBeGreaterThan(0);
  expect(v.apps).toEqual({ serving: 0, asleep: 0, previews: 0 });
  // Everyone else gets the platform's short shape, never the numbers.
  for (const token of [plain, undefined]) {
    const res = await health(token);
    expect(res.status).toBe(200);
    const short = (await res.json()) as Record<string, unknown>;
    expect(short["disk"]).toBeUndefined();
    expect(short["rollout"]).toBeDefined();
  }
  expect((await fetch(servers.url + "/healthz")).status).toBe(200);
});

test("a full queue shows in queue, and an old one in needs", async () => {
  // Errors and refused calls are process-wide: another file in the shard may have left some.
  app.signals.errors.clear();
  app.signals.refused.clear();
  const old = Date.now() - 3_600_000;
  for (let i = 0; i < 3; i++) createRun(app.db, { repoId, kind: "agent" });
  const v = vitals({ db: app.db, signals: app.signals, dataDir });
  expect(v.queue).toEqual({ agent: 3 });
  // Process-wide signals (errors, refused calls) from other suites may speak too.
  expect(v.needs.join(" ")).not.toContain("queue");
  const later = vitals({ db: app.db, signals: app.signals, dataDir, now: old + 2 * 3_600_000 + 3_600_000 });
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
  expect(vitals({ db: app.db, signals: app.signals, dataDir }).stuck).toEqual([]);
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
    vitals({ db: counting, signals: app.signals, dataDir });
    return n;
  };
  const before = count();
  for (let i = 0; i < 40; i++) {
    const r = createRun(app.db, { repoId, kind: "check" });
    if (i % 2) app.db.query("UPDATE run SET state='running' WHERE id=?1").run(r.id);
  }
  expect(count()).toBe(before);
  // The queue, the running runs, the runs killed twice for their budget, and the lane's depth and finished checks.
  expect(before).toBe(5);
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
    expect(vitals({ db: app.db, signals: app.signals, dataDir }).needs.some((n) => n.includes("errors in the last hour"))).toBe(true);
    expect(vitals({ db: app.db, signals: app.signals, dataDir, now: Date.now() + 2 * 3_600_000 }).errors.lastHour).toBe(0);
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
  expect(vitals({ db: app.db, signals: app.signals, dataDir, now }).lane).toEqual({
    queued: 0, running: null, medianMinutes: null, clearsInMinutes: null,
  });
  expect(laneLine(vitals({ db: app.db, signals: app.signals, dataDir, now }).lane, now)).toBeNull();
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
  const lane = vitals({ db: app.db, signals: app.signals, dataDir, now }).lane;
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
  const later = vitals({ db: app.db, signals: app.signals, dataDir, now: now + 3_600_000 });
  const cause = later.needs.find((n) => n.includes("one lane"));
  expect(cause).toMatch(/^The check queue has waited over 30 minutes; 6 checks queued .*; one lane, checks run one at a time\.$/);
  expect(cause).not.toContain("Lane:");
});

test("an unauthenticated internal call is refused, logged and flagged; the probe is not", async () => {
  app.signals.refused.clear();
  const flagged = () =>
    vitals({ db: app.db, signals: app.signals, dataDir: app.config.dataDir }).needs.filter((n) =>
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
  const dirB = await mkdtemp(join(tmpdir(), "forge-vitals-b-"));
  const other = createApp({ dataDir: dirB, port: 0 });
  try {
    const needs = (a: App) =>
      vitals({ db: a.db, dataDir: a.config.dataDir, signals: a.signals }).needs;
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
    const later = createApp({ dataDir: dirC, port: 0 });
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
    const base = vitals({ db: app.db, signals: app.signals, dataDir });
    expect(base.degraded.map((d) => d.cause)).not.toContain("errors");

    // queue: since is the oldest queued run's createdAt.
    app.db.query("DELETE FROM run").run();
    createRun(app.db, { repoId, kind: "agent" });
    const oldest = (
      app.db.query("SELECT MIN(created_at) AS m FROM run WHERE state='queued' AND kind='agent'").get() as { m: string }
    ).m;
    const later = Date.now() + 2 * QUEUE_WAIT_MAX_MS;
    const q = vitals({ db: app.db, signals: app.signals, dataDir, now: later }).degraded.find((d) => d.cause === "queue:agent");
    expect(q?.since).toBe(new Date(oldest).toISOString());
    expect(q?.href).toBe("/settings/capacity");

    // stuck: one per run, keyed by run id, since is when it last moved.
    const run = createRun(app.db, { repoId, kind: "deploy", env: "production" });
    const moved = new Date(Date.now() - 10 * 60_000).toISOString();
    app.db
      .query("UPDATE run SET state='running', started_at=?2, heartbeat_at=?2 WHERE id=?1")
      .run(run.id, moved);
    const s = vitals({ db: app.db, signals: app.signals, dataDir });
    const entry = s.degraded.find((d) => d.cause === `stuck:${run.id}`);
    expect(entry?.since).toBe(moved);
    expect(entry?.href).toBe(`/alice/r/runs/${run.id}`);
    expect(s.needs).toContain(entry!.sentence);
    app.db.query("UPDATE run SET state='ok' WHERE id=?1").run(run.id);

    // errors: no recorded start, so since is at; the cause is stable across calls.
    const log = createLog("probe");
    for (let i = 0; i < ERROR_BURST; i++) log.error(`boom ${i}`);
    const a = vitals({ db: app.db, signals: app.signals, dataDir });
    const e = a.degraded.find((d) => d.cause === "errors");
    const later2 = vitals({ db: app.db, signals: app.signals, dataDir, now: Date.now() + 5000 });
    expect(e?.since).toBe(app.signals.errors.recent(100).oldest!);
    expect(later2.degraded.find((d) => d.cause === "errors")?.since).toBe(e!.since);
    expect(e?.href).toBe("/settings/capacity#errors");

    // internal: refused calls.
    await fetchInternal(app.hookAddress.current, "/internal/hook", { method: "POST" });
    const i = vitals({ db: app.db, signals: app.signals, dataDir }).degraded.find((d) => d.cause === "internal");
    expect(i?.href).toBe("/settings/capacity#internal");
    const i2 = vitals({ db: app.db, signals: app.signals, dataDir, now: Date.now() + 5000 }).degraded.find((d) => d.cause === "internal");
    expect(i2?.since).toBe(i!.since);
    expect(i!.since).toBe(app.signals.refused.recent().oldest!);

    // a cause that clears is forgotten: when it returns it began again.
    const first = e!.since;
    clearErrors();
    expect(vitals({ db: app.db, signals: app.signals, dataDir }).degraded.some((d) => d.cause === "errors")).toBe(false);
    for (let k = 0; k < ERROR_BURST; k++) log.error(`again ${k}`);
    const again = vitals({ db: app.db, signals: app.signals, dataDir }).degraded.find((d) => d.cause === "errors");
    expect(again?.since).toBe(app.signals.errors.recent(100).oldest!);
    expect(again!.since > first).toBe(true);

    // a caller's `now` never moves a fallback start: it is the real clock's.
    const early = vitals({ db: app.db, signals: app.signals, dataDir, diskFreeMin: 2, now: 1_000 });
    const d0 = early.degraded.find((d) => d.cause === "disk")!;
    expect(Date.parse(d0.since)).toBeGreaterThan(Date.parse("2020-01-01"));

    // every need has one matching sentence in degraded.
    const all = vitals({ db: app.db, signals: app.signals, dataDir });
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
  expect(vitals({ db: app.db, signals: app.signals, dataDir }).degraded.some((d) => d.cause === "disk")).toBe(false);
  const a = vitals({ db: app.db, signals: app.signals, dataDir, diskFreeMin: 2 }).degraded.find((d) => d.cause === "disk");
  expect(a?.href).toBe("/settings/capacity");
  await Bun.sleep(5);
  const b = vitals({ db: app.db, signals: app.signals, dataDir, diskFreeMin: 2 }).degraded.find((d) => d.cause === "disk");
  expect(b?.since).toBe(a!.since);
  expect(vitals({ db: app.db, signals: app.signals, dataDir }).degraded.some((d) => d.cause === "disk")).toBe(false);
  await Bun.sleep(5);
  const c = vitals({ db: app.db, signals: app.signals, dataDir, diskFreeMin: 2 }).degraded.find((d) => d.cause === "disk");
  expect(c!.since > a!.since).toBe(true);
  vitals({ db: app.db, signals: app.signals, dataDir });
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
  const other = createApp({ dataDir: dirB, port: 0 });
  try {
    const disk = (a: App, diskFreeMin: number) =>
      vitals({ db: a.db, dataDir: a.config.dataDir, signals: a.signals, diskFreeMin })
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
