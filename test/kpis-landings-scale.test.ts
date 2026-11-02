/**
 * #7627: the day's landings are read in one pass. On a forge of 20,000 merged
 * pulls `readKpis` costs a bounded number of statements, and its count is the one the old
 * per-row `NOT EXISTS` gave: a commit landed twice, or landed before the day
 * and carried again today, counts once or not at all.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readKpis } from "../src/flow/kpis.ts";
import { expectWork } from "./helpers/work.ts";
import { statements } from "./helpers/statements.ts";
import { snappyFixture, type SnappyFixture } from "../bench/snappy.ts";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const PULLS = 20_000;

let f: SnappyFixture;

/** The query #7627 replaced: one `NOT EXISTS` over every pull for each landing. */
const naive = (since: string, to: string): number =>
  f.app.db
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n
         FROM pull p JOIN issue i ON i.id = p.issue_id JOIN repo r ON r.id = i.repo_id
        WHERE p.base_branch = r.default_branch
          AND p.merged_at >= ?1 AND p.merged_at <= ?2
          AND p.merged_oid IS NOT NULL AND p.merged_oid != '' AND p.merged_oid != p.base_oid
          AND NOT EXISTS (
            SELECT 1 FROM pull q JOIN issue j ON j.id = q.issue_id
             WHERE j.repo_id = i.repo_id AND q.merged_oid = p.merged_oid
               AND (q.merged_at < p.merged_at OR (q.merged_at = p.merged_at AND q.issue_id < p.issue_id)))`,
    )
    .get(since, to)!.n;

beforeAll(async () => {
  f = await snappyFixture({ repos: 2, issuesPerRepo: 0 });
  const db = f.app.db;
  const issue = db.query(
    `INSERT INTO issue (id, repo_id, number, kind, title, author_id, state) VALUES (?1, ?2, ?3, 'pull', 'p', ?4, 'closed')`,
  );
  const pull = db.query(
    `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at, merged_oid)
     VALUES (?1, ?2, ?3, ?4, '', ?5, ?6)`,
  );
  db.transaction(() => {
    for (let k = 0; k < PULLS; k++) {
      const repo = f.repos[k % 2]!;
      const id = `scale-${String(k).padStart(6, "0")}`;
      // Spread over 30 days, a few minutes apart: about 670 fall in the last day.
      const at = new Date(NOW - Math.floor((k * 30 * 24 * HOUR) / PULLS)).toISOString();
      // Every 50th pull carries the commit of the pull 2 before it (same repository): a duplicate landing.
      const oid = k % 50 === 0 && k >= 2 ? `oid-${k - 2}` : `oid-${k}`;
      // Every 97th merged into the base it found: an empty landing.
      const base = k % 97 === 0 ? oid : `base-${k}`;
      issue.run(id, repo.id, 1000 + k, f.owner.id);
      pull.run(id, repo.defaultBranch, `b/${k}`, base, at, oid);
    }
    // A commit that landed before the day and is carried again in the last hour counts zero times.
    const old = new Date(NOW - 3 * 24 * HOUR).toISOString();
    const late = new Date(NOW - 10 * 60_000).toISOString();
    for (const [id, at, n] of [["carried-old", old, 900], ["carried-late", late, 901]] as const) {
      issue.run(id, f.repos[0]!.id, n, f.owner.id);
      pull.run(id, f.repos[0]!.defaultBranch, `b/${id}`, "base-x", at, "oid-carried");
    }
    // The same commit merged twice in one instant counts once.
    for (const [id, n] of [["twin-a", 902], ["twin-b", 903]] as const) {
      issue.run(id, f.repos[1]!.id, n, f.owner.id);
      pull.run(id, f.repos[1]!.defaultBranch, `b/${id}`, "base-y", late, "oid-twin");
    }
  })();
}, 120_000);

afterAll(async () => {
  await f.close();
});

test("readKpis costs a bounded number of statements over 20,000 merged pulls", async () => {
  readKpis(f.app.db, new Date(NOW));
  // Counted, not timed (#7824): the figures are a few set-based reads, never one per merged pull.
  expectWork(await statements(f.app.db, () => void readKpis(f.app.db, new Date(NOW))), { max: 12 });
});

test("the count matches the per-row NOT EXISTS, duplicates counted once", () => {
  // Run after the timing, so readKpis is timed on the schema production has: the
  // old query is seconds without an index on merged_oid, and this one is the test's own.
  f.app.db.run("CREATE INDEX test_pull_merged_oid ON pull(merged_oid)");
  const now = new Date(NOW);
  const since = new Date(NOW - 24 * HOUR).toISOString();
  const want = naive(since, now.toISOString());
  const k = readKpis(f.app.db, now);
  expect(k.landed).toBe(want);
  expect(k.landed).toBeGreaterThan(600);
  // The last hour: the twins count once, the carried commit not at all.
  const lastHour = naive(new Date(NOW - HOUR).toISOString(), now.toISOString());
  expect(k.landedHours[0]).toBe(lastHour);
});
