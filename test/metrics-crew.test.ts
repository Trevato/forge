/** The check and crew families of `/metrics` move with the tables they read (#3751). */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createRun } from "../src/core/runs.ts";
import { recordUsage } from "../src/core/usage.ts";
import { createUser } from "../src/core/users.ts";
import { forgeMetrics } from "../src/metrics/forge.ts";

let dir: string;
let app: App;
let repoId: string;
let scoutId: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "metrics-crew-"));
  app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, adminIfFirst: boolean) => {
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst,
    });
    if (!u.ok) throw new Error(u.error);
    return u.value;
  };
  const alice = await mk("alice", true);
  scoutId = (await mk("scout", false)).id;
  const made = await createRepo(app, alice, { name: "one", visibility: "public" });
  if (!made.ok) throw new Error("repo");
  repoId = made.value.id;
}, 60_000);

afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const line = (text: string, re: string) => new RegExp(`^${re} (\\S+)$`, "m").exec(text)?.[1];

test("a finished check moves the duration histogram", () => {
  const now = Date.now();
  expect(line(forgeMetrics(app.db), "forge_check_duration_seconds_count")).toBe("0");
  const run = createRun(app.db, { repoId, kind: "check" });
  app.db
    .query(`UPDATE run SET state = 'ok', started_at = ?2, finished_at = ?3 WHERE id = ?1`)
    .run(run.id, new Date(now - 29_999).toISOString(), new Date(now + 1).toISOString());
  const text = forgeMetrics(app.db);
  expect(line(text, "forge_check_duration_seconds_count")).toBe("1");
  expect(line(text, 'forge_check_duration_seconds_bucket\\{le="15"\\}')).toBe("0");
  expect(line(text, 'forge_check_duration_seconds_bucket\\{le="60"\\}')).toBe("1");
  expect(Number(line(text, "forge_check_duration_seconds_sum"))).toBeCloseTo(30, 3);
});

test("the check histogram never drops: a check is counted once and stays counted", () => {
  const before = forgeMetrics(app.db);
  expect(forgeMetrics(app.db)).toBe(before);
  const run = createRun(app.db, { repoId, kind: "check" });
  const end = Date.now() + 5_000;
  app.db
    .query(`UPDATE run SET state = 'failed', started_at = ?2, finished_at = ?3 WHERE id = ?1`)
    .run(run.id, new Date(end - 4_000).toISOString(), new Date(end).toISOString());
  const n = Number(line(before, "forge_check_duration_seconds_count"));
  expect(line(forgeMetrics(app.db), "forge_check_duration_seconds_count")).toBe(String(n + 1));
  expect(line(forgeMetrics(app.db), "forge_check_duration_seconds_count")).toBe(String(n + 1));
  app.db.query(`DELETE FROM run WHERE id = ?1`).run(run.id);
  expect(line(forgeMetrics(app.db), "forge_check_duration_seconds_count")).toBe(String(n + 1));
});

test("a queued check moves the queue gauge, an agent run does not", () => {
  expect(line(forgeMetrics(app.db), "forge_check_queue_depth")).toBe("0");
  createRun(app.db, { repoId, kind: "agent", actorId: scoutId });
  expect(line(forgeMetrics(app.db), "forge_check_queue_depth")).toBe("0");
  createRun(app.db, { repoId, kind: "check" });
  expect(line(forgeMetrics(app.db), "forge_check_queue_depth")).toBe("1");
});

test("a recorded run moves runs and spend, by member", () => {
  const before = forgeMetrics(app.db);
  expect(before).not.toContain("forge_crew_runs_total{");
  const run = createRun(app.db, { repoId, kind: "agent", actorId: scoutId });
  app.db.query(`UPDATE run SET state = 'failed' WHERE id = ?1`).run(run.id);
  recordUsage(app.db, {
    runId: run.id,
    repoId,
    issueId: null,
    agentId: scoutId,
    subscriptionId: null,
    tokensIn: 10,
    tokensOut: 5,
    costUsd: 0.42,
    wallMs: 1000,
    outcome: "failed",
    at: new Date().toISOString(),
  });
  const text = forgeMetrics(app.db);
  expect(line(text, 'forge_crew_runs_total\\{member="scout",outcome="failed"\\}')).toBe("1");
  expect(line(text, 'forge_crew_spend_usd_total\\{member="scout"\\}')).toBe("0.42");
});

test("docs/METRICS.md lists the four families", async () => {
  const doc = await readFile(join(import.meta.dir, "../docs/METRICS.md"), "utf8");
  for (const name of [
    "forge_check_duration_seconds",
    "forge_check_queue_depth",
    "forge_crew_runs_total",
    "forge_crew_spend_usd_total",
  ])
    expect(doc).toContain(`\`${name}\``);
});
