/**
 * The retention jobs (`system/retention.ts`): each slice is bounded and idempotent, the pace is the
 * cost of the slice (a job takes a twentieth of the thread at most), the old ledger waits for
 * `deploy_landed` to be filled from it, and starting the jobs starts them all and stopping stops them.
 */
import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { App } from "../src/app.ts";
import { migrations } from "../src/core/schema.ts";
import { openDb } from "../src/kernel/db.ts";
import { DUTY, gapAfter, IDLE_MS, MIN_GAP_MS, retentionJobs, startRetention } from "../src/system/retention.ts";

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

function seeded(): { db: Database; app: App } {
  const db = openDb(":memory:", migrations);
  db.exec("PRAGMA foreign_keys = OFF");
  const app = { db, log: { warn: () => {}, info: () => {} } } as unknown as App;
  return { db, app };
}

/** A repository with `pulls` merged pulls, each followed by a production deploy that carries it and every pull before it. */
function ledger(db: Database, pulls: number, now: number): void {
  db.query("INSERT INTO repo (id, owner_id, name) VALUES ('r1', 'u1', 'engine')").run();
  const issue = db.query("INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, 'r1', ?2, 'pull', 't', '', 'u1', 'closed', ?3)");
  const pull = db.query("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at, merged_oid) VALUES (?1, 'main', 'b', 'a', 'b', ?2, ?3)");
  const run = db.query("INSERT INTO run (id, repo_id, kind, env, state, serving_at, finished_at, created_at) VALUES (?1, 'r1', 'deploy', 'production', 'ok', ?2, ?2, ?2)");
  const carry = db.query("INSERT INTO deploy_pull (run_id, issue_id, pull_number, merged_oid) VALUES (?1, ?2, ?3, 'o')");
  db.transaction(() => {
    for (let i = 0; i < pulls; i++) {
      const merged = iso(now - (pulls - i) * 3_600_000);
      issue.run(`p${i}`, i + 1, merged);
      pull.run(`p${i}`, merged, `oid${i}`);
      run.run(`d${i}`, iso(now - (pulls - i) * 3_600_000 + 60_000));
      for (let j = 0; j <= i; j++) carry.run(`d${i}`, `p${j}`, j + 1);
    }
  })();
}

describe("pace", () => {
  test("a job with more behind it waits twenty slices' time, never under the floor; with nothing behind, its idle gap", () => {
    expect(DUTY).toBeLessThanOrEqual(0.05);
    expect(gapAfter(20, true)).toBe(Math.ceil(20 * (1 / DUTY - 1)));
    expect(gapAfter(1, true)).toBe(MIN_GAP_MS);
    expect(gapAfter(500, false)).toBe(IDLE_MS);
    expect(gapAfter(500, false, 3_600_000)).toBe(3_600_000);
    // The share of the thread taken: slice over slice plus wait.
    for (const t of [5, 20, 80]) expect(t / (t + gapAfter(t, true))).toBeLessThanOrEqual(DUTY + 1e-9);
  });
});

describe("the jobs", () => {
  test("the ledger is trimmed only after deploy_landed holds what it names, and the old rows then go", () => {
    const { db, app } = seeded();
    const now = Date.now();
    ledger(db, 30, now - 3 * DAY);
    const jobs = retentionJobs(app);
    // Before the backfill's pass: nothing is deleted, whatever the age.
    expect(jobs.deploys.slice(now)).toEqual({ did: 0, more: false });
    expect(db.query("SELECT COUNT(*) AS n FROM deploy_pull").get()).toEqual({ n: (30 * 31) / 2 });
    // The 30 pulls merged 3 days ago are inside the week the backfill reads; a pass ends when a slice finds no more.
    let slices = 0;
    for (;;) {
      slices++;
      if (!jobs.backfill.slice(now).more) break;
    }
    expect(slices).toBeGreaterThanOrEqual(1);
    expect(jobs.landedReady()).toBe(true);
    expect(db.query("SELECT COUNT(*) AS n FROM deploy_landed").get()).toEqual({ n: 30 });
    // Each pull is first live in the deploy that came a minute after its merge.
    expect(db.query("SELECT run_id FROM deploy_landed WHERE issue_id = 'p7'").get()).toEqual({ run_id: "d7" });
    let trimmed = 0;
    for (;;) {
      const r = jobs.deploys.slice(now);
      trimmed += r.did;
      if (!r.more) break;
    }
    expect(trimmed).toBe((30 * 31) / 2);
    expect(db.query("SELECT COUNT(*) AS n FROM deploy_pull").get()).toEqual({ n: 0 });
    // The answers survive the trim: the same rows are there.
    expect(db.query("SELECT COUNT(*) AS n FROM deploy_landed").get()).toEqual({ n: 30 });
  });

  test("each job's slice is idempotent and reports no more when its window holds nothing", () => {
    const { app } = seeded();
    const jobs = retentionJobs(app);
    const now = Date.now();
    for (const job of [jobs.events, jobs.live, jobs.samples, jobs.backfill, jobs.deploys]) {
      expect(job.slice(now).more).toBe(false);
      expect(job.slice(now).more).toBe(false);
    }
  });

  test("starting the jobs runs the backfill at once; stopping them leaves no timer to fire", async () => {
    const { db, app } = seeded();
    ledger(db, 5, Date.now() - DAY);
    const stop = startRetention(app, { local: true, engine: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(db.query("SELECT COUNT(*) AS n FROM deploy_landed").get()).toEqual({ n: 5 });
    stop();
    db.query("DELETE FROM deploy_landed").run();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(db.query("SELECT COUNT(*) AS n FROM deploy_landed").get()).toEqual({ n: 0 });
  });
});
