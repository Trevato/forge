/** Rule breakers (#7560): one comment with rule, place and fix; a repeat says nothing; a plain red gets none. */
import { expect, test } from "bun:test";
import { commentBreakers } from "../src/rules/breaker.ts";
import { breachOf } from "../src/rules/table.ts";
import { rulesWorld } from "./helpers/rules-app.ts";
import { seedCheck, seedPull } from "./helpers/rules-seed.ts";

const w = rulesWorld();
const RAW = "no raw wall-clock budget in a test (#4429) > test/x.test.ts:4: expect(performance.now() - t0).toBe" + "LessThan(5);";
const PIN = "a migration on main is never edited (#783) > src/core/migrations/2026-x.ts is not pinned: run bun scripts/pin-migrations.ts";
const comments = (pullId: string) => w.app.db.query<{ body: string }, [string]>("SELECT body FROM comment WHERE issue_id = ?1").all(pullId).map((c) => c.body);

test("the table names the rule, the file, the line and the fix", () => {
  expect(breachOf(RAW)).toMatchObject({ file: "test/x.test.ts", line: 4, rule: expect.stringContaining("#4429"), fix: expect.stringContaining("expectWork") });
  expect(breachOf("a migration on main is never edited (#783) > src/core/migrations/2026-x.ts is not pinned: run it")).toMatchObject({ file: "src/core/migrations/2026-x.ts", fix: expect.stringContaining("pin-migrations") });
  expect(breachOf("some other > test")).toBeUndefined();
  expect(breachOf("no raw wall-clock budget in a test (#4429) > clean")).toBeUndefined();
});

test("a pull red on a rule gets one comment; pushing again with the same breach adds none", () => {
  const p = seedPull(w.app.db, w.repoId, w.ownerId);
  seedCheck(w.app.db, w.repoId, p.id, "failed", [RAW]);
  expect(commentBreakers(w.app.db, new Date())).toEqual([p.id]);
  const [body] = comments(p.id);
  expect(comments(p.id)).toHaveLength(1);
  expect(body).toContain("test/x.test.ts:4");
  expect(body).toContain("expectWork");
  expect(body).toContain("#4429");

  seedCheck(w.app.db, w.repoId, p.id, "failed", [RAW]);
  expect(commentBreakers(w.app.db, new Date())).toEqual([]);
  expect(commentBreakers(w.app.db, new Date())).toEqual([]);
  expect(comments(p.id)).toHaveLength(1);
});

test("a different breach is a new comment; a red that breaks no rule, or a green check, gets none", () => {
  const p = seedPull(w.app.db, w.repoId, w.ownerId);
  seedCheck(w.app.db, w.repoId, p.id, "failed", [RAW]);
  commentBreakers(w.app.db, new Date());
  seedCheck(w.app.db, w.repoId, p.id, "failed", [PIN]);
  expect(commentBreakers(w.app.db, new Date())).toEqual([p.id]);
  expect(comments(p.id)).toHaveLength(2);

  const plain = seedPull(w.app.db, w.repoId, w.ownerId);
  seedCheck(w.app.db, w.repoId, plain.id, "failed", ["grp > ordinary failure"]);
  const green = seedPull(w.app.db, w.repoId, w.ownerId);
  seedCheck(w.app.db, w.repoId, green.id, "ok");
  expect(commentBreakers(w.app.db, new Date())).toEqual([]);
  expect(comments(plain.id)).toEqual([]);
  expect(comments(green.id)).toEqual([]);
});

test("only a pull's latest check speaks: a breach already fixed is not commented", () => {
  const p = seedPull(w.app.db, w.repoId, w.ownerId);
  seedCheck(w.app.db, w.repoId, p.id, "failed", [RAW.replace("x.test", "fixed.test")]);
  seedCheck(w.app.db, w.repoId, p.id, "ok");
  expect(commentBreakers(w.app.db, new Date())).toEqual([]);
});

test("the comment is the rule watcher's, never the repository owner's", () => {
  const p = seedPull(w.app.db, w.repoId, w.ownerId);
  seedCheck(w.app.db, w.repoId, p.id, "failed", [RAW]);
  commentBreakers(w.app.db, new Date());
  const row = w.app.db
    .query<{ author_id: string; username: string; is_agent: number }, [string]>("SELECT c.author_id, u.username, u.is_agent FROM comment c JOIN user u ON u.id = c.author_id WHERE c.issue_id = ?1")
    .get(p.id)!;
  expect(row.author_id).not.toBe(w.ownerId);
  expect(row).toMatchObject({ username: "rule-watcher", is_agent: 1 });
});
