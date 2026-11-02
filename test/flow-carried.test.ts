/** A pull closed as carried (#8628) lands nothing: the clog tick, the keeper's rate and the home figures leave it out. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { snappyFixture, type SnappyFixture } from "../bench/snappy.ts";
import { loadClog, tickClog } from "../src/flow/clog_tick.ts";
import { hourly, landedBetween } from "../src/flow/keeper_rate.ts";
import { readKpis } from "../src/flow/kpis.ts";

const MIN = 60_000;
let f: SnappyFixture;
let n = 0;

/** A merged pull on the default branch; `carried` says it found its change already there. */
function merged(at: number, carried: boolean): void {
  const repo = f.repos[0]!;
  const id = `carried-${n}`;
  f.app.db
    .query(`INSERT INTO issue (id, repo_id, number, kind, title, author_id, state) VALUES (?1, ?2, ?3, 'pull', 'p', ?4, 'closed')`)
    .run(id, repo.id, 5000 + n, f.owner.id);
  // Its own merged_oid, never the base's: only the flag can keep it out.
  f.app.db
    .query(
      `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at, merged_oid, carried)
       VALUES (?1, ?2, ?3, ?4, '', ?5, ?6, ?7)`,
    )
    .run(id, repo.defaultBranch, `b/${id}`, `base-${n}`, new Date(at).toISOString(), `oid-${n}`, carried ? 1 : 0);
  n++;
}

beforeAll(async () => {
  f = await snappyFixture({ repos: 1, issuesPerRepo: 0 });
}, 60_000);
afterAll(async () => {
  await f.close();
});

test("a carried pull is no landing in the keeper's rate, the hourly bars or the home figures", () => {
  const now = Date.now();
  merged(now - 10 * MIN, false);
  for (let i = 0; i < 3; i++) merged(now - (20 + i) * MIN, true);
  expect(landedBetween(f.app.db, now - 60 * MIN, now)).toBe(1);
  expect(hourly(f.app.db, now, 3).landed.reduce((a, b) => a + b, 0)).toBe(1);
  expect(readKpis(f.app.db, new Date(now)).landed).toBe(1);
});

test("ten carried closes in two hours are not ten landings: the clog tick still sees the clog", () => {
  const now = Date.now();
  for (let i = 0; i < 10; i++) merged(now - (30 + i) * MIN, true);
  tickClog(f.app.db, f.app.bus, new Date(now + MIN));
  expect(loadClog(f.app.db)?.firstReasons.join(" ")).toContain("landed of");
  expect(loadClog(f.app.db)?.firstReasons.join(" ")).not.toContain("11 landed");
});
