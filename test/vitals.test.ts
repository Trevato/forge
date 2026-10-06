/** The forge's standing: its shape, the admin gate, and what it flags. */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRun } from "../src/core/runs.ts";
import { vitals } from "../src/kernel/vitals.ts";
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
      "apps", "at", "checkedAt", "commit", "disk", "draining", "errors",
      "incidents", "memory", "needs", "ok", "queue", "rollout", "stale", "stuck",
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

test("a full queue shows in queue, and an old one in needs", () => {
  const old = Date.now() - 3_600_000;
  for (let i = 0; i < 3; i++) createRun(app.db, { repoId, kind: "agent" });
  const v = vitals({ db: app.db, dataDir });
  expect(v.queue).toEqual({ agent: 3 });
  expect(v.ok).toBe(true);
  const later = vitals({ db: app.db, dataDir, now: old + 2 * 3_600_000 + 3_600_000 });
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
  expect(vitals({ db: app.db, dataDir }).stuck).toEqual([]);
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
    vitals({ db: counting, dataDir });
    return n;
  };
  const before = count();
  for (let i = 0; i < 40; i++) {
    const r = createRun(app.db, { repoId, kind: "check" });
    if (i % 2) app.db.query("UPDATE run SET state='running' WHERE id=?1").run(r.id);
  }
  expect(count()).toBe(before);
  // The queue, the running runs, and the egress mode (`core/capacity.ts`).
  expect(before).toBe(3);
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
    expect(vitals({ db: app.db, dataDir }).needs.some((n) => n.includes("errors in the last hour"))).toBe(true);
    expect(vitals({ db: app.db, dataDir, now: Date.now() + 2 * 3_600_000 }).errors.lastHour).toBe(0);
  } finally {
    console.error = orig;
    clearErrors();
  }
});
