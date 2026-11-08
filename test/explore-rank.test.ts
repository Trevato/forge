/** /explore's rank phase stays within budget with 500 public repositories (#3394). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { explore, parseExploreQuery } from "../src/actions/explore.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { createIssue } from "../src/core/issues.ts";
import { createUser, type User } from "../src/core/users.ts";
import { countStatements } from "../bench/run.ts";
import { quietLogs } from "./helpers/globals.ts";
import { proveAll } from "./helpers/verified.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

let dataDir: string;
let app: App;
let owner: User;
const DAY = 86_400_000;

// The setup is one promise the teardown waits for: when a hook gives up on a
// slow machine, the loop still running must not write into a closed database
// and escape every test as an unhandled error (#5667).
let setup: Promise<void> = Promise.resolve();
let stopped = false;

async function seed(): Promise<void> {
  dataDir = await mkdtemp(join(tmpdir(), "forge-explore-rank-"));
  app = createApp({ dataDir, port: 0 });
  const made = await createUser(app.db, {
    origin: "seed",
    username: "olive",
    email: "olive@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: false,
  });
  if (!made.ok) throw new Error(made.error);
  proveAll(app);
  promote(app.db, made.value);
  owner = made.value;
  const now = Date.now();
  for (let i = 0; i < 500 && !stopped; i++) {
    const repo = await createRepo(app, owner, {
      name: `app-${i}`,
      visibility: i === 7 ? "private" : "public",
    });
    if (!repo.ok) throw new Error(String(repo.error));
    const rec = insertApp(app.db, {
      repoId: repo.value.id,
      slug: `olive-app-${i}`,
      access: i === 7 ? "private" : "public",
    });
    if (!rec.ok) throw new Error(rec.error);
    // A week of activity: a merged pull every few repositories, hours awake on others.
    if (i % 3 === 0) {
      const issue = createIssue(app.db, {
        repoId: repo.value.id,
        authorId: owner.id,
        title: "change",
        kind: "pull",
      });
      if (!issue.ok) throw new Error(issue.error);
      app.db
        .query(
          `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at)
           VALUES (?1, 'main', 'b', '', '', ?2)`,
        )
        .run(issue.value.id, new Date(now - (i % 7) * DAY - 3_600_000).toISOString());
    }
    if (i % 2 === 0)
      app.db
        .query(
          `INSERT INTO meter (repo_id, env, placement, started_at, beat_at, ended_at)
           VALUES (?1, 'production', 'owned', ?2, ?3, ?3)`,
        )
        .run(
          repo.value.id,
          new Date(now - (i % 6) * DAY - 5 * 3_600_000).toISOString(),
          new Date(now - (i % 6) * DAY).toISOString(),
        );
  }
  if (stopped) throw new Error("never came: the seed was torn down before all 500 repositories were made"); // teardown awaits setup.catch
}
beforeAll(() => {
  setup = seed();
  return setup;
}, 300_000);
afterAll(async () => {
  stopped = true;
  await setup.catch(() => {});
  if (app !== undefined) app.close();
  await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const query = parseExploreQuery("");

test("a warm rank of 500 public repositories is a fraction of a cold one and within its budget", async () => {
  const cold: number[] = [];
  const warm: number[] = [];
  await explore(app, undefined, query);
  for (let i = 0; i < 5; i++) {
    let t = performance.now();
    await explore(app, undefined, query, Date.now());
    cold.push(performance.now() - t);
    t = performance.now();
    await explore(app, undefined, query);
    warm.push(performance.now() - t);
  }
  expect(Math.min(...warm) * 5).toBeLessThan(Math.min(...cold));
});

test("a cold rank runs many statements, a warm one only the write clock", async () => {
  const cold = countStatements(app.db);
  await explore(app, undefined, query, Date.now());
  const coldN = cold.count;
  cold.stop();
  await explore(app, undefined, query);
  const warm = countStatements(app.db);
  await explore(app, undefined, query);
  const warmN = warm.count;
  warm.stop();
  expect(coldN).toBeGreaterThan(3);
  expect(warmN).toBeLessThanOrEqual(2);
});

test("a warm request reads nothing but the write clock", async () => {
  await explore(app, undefined, query);
  const sql = countStatements(app.db);
  await explore(app, undefined, query);
  const n = sql.count;
  const only = sql.top().map((t) => t.sql);
  sql.stop();
  expect(only.length).toBe(1);
  expect(only[0]).toContain("total_changes()");
  expect(n).toBeLessThanOrEqual(2);
});

test("the cached order is the computed order, and a new write shows on the next request", async () => {
  const first = await explore(app, undefined, query);
  const again = await explore(app, undefined, query);
  expect(again).toEqual(first);
  // Asked at a given time it is ranked afresh: the same order.
  const fresh = await explore(app, undefined, query, Date.now());
  expect(fresh.map((r) => r.name)).toEqual(first.map((r) => r.name));
  expect(first.length).toBe(60);
  expect(first.some((r) => r.name === "olive/app-7")).toBe(false);
  // A fork by someone else moves the repository up at the next request.
  const target = first.filter((r) => r.kind === "app").at(-1)!;
  const parent = app.db
    .query<{ id: string }, [string]>(
      `SELECT repo.id FROM repo JOIN user ON user.id = repo.owner_id WHERE user.username || '/' || repo.name = ?1`,
    )
    .get(target.name)!;
  app.db.query(`UPDATE repo SET fork_parent_id = ?1 WHERE name = 'app-1'`).run(parent.id);
  const after = await explore(app, undefined, query);
  expect(after.find((r) => r.name === target.name)!.numbers.forks).toBe(1);
});

test("an admin's warm request reads the write clock and the spawned forges, and still lists them", async () => {
  await mkdir(join(dataDir, "spawn"), { recursive: true });
  await Bun.write(
    join(dataDir, "spawn", "kid.json"),
    JSON.stringify({ name: "kid", bodyId: "b", url: "http://kid", planHash: "h", done: true }),
  );
  const forgeQuery = parseExploreQuery("kind:forge");
  const admin = { ...owner, isAdmin: true } as User;
  await explore(app, admin, forgeQuery);
  const sql = countStatements(app.db);
  const rows = await explore(app, admin, forgeQuery);
  const only = sql.top().map((t) => t.sql);
  sql.stop();
  expect(only.length).toBe(1);
  expect(only[0]).toContain("total_changes()");
  expect(rows.some((r) => r.kind === "forge" && r.name === "kid")).toBe(true);
  // Forges are read fresh: a stranger sees none, and the kept rows are not changed by the admin's.
  const stranger = await explore(app, undefined, query);
  expect(stranger.some((r) => r.kind === "forge")).toBe(false);
  expect(Object.isFrozen(stranger[0])).toBe(true);
  // With every kind asked, the same kept rows serve the admin and the forge rows sort among them.
  const all = await explore(app, admin, query);
  expect(all.length).toBeLessThanOrEqual(60);
});

test("the same id with another admin standing is ranked on its own, not served the other's", async () => {
  const fresh = parseExploreQuery("sort:forks");
  const plain = { ...owner, isAdmin: false } as User;
  const admin = { ...owner, isAdmin: true } as User;
  await explore(app, plain, fresh);
  const sql = countStatements(app.db);
  await explore(app, admin, fresh);
  const n = sql.count;
  sql.stop();
  expect(n).toBeGreaterThan(3);
});
