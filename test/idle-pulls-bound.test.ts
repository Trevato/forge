/** readIdlePulls never scans `event` and stays fast on a big forge (#6896). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectWork } from "./helpers/work.ts";
import { statements } from "./helpers/statements.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { IDLE_PULLS_SQL, readIdlePulls } from "../src/flow/idle_pulls.ts";

const NOW = new Date("2026-10-26T12:00:00.000Z");
const ago = (h: number): string => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const PULLS = 400;
const EVENTS = 20_000;

let dir: string;
let app: App;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "idle-bound-"));
  app = createApp({ dataDir: dir, port: 0 });
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "scout",
    email: "scout@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  app.db.run("UPDATE user SET is_agent = 1 WHERE id = ?1", [u.value.id]);
  app.db.run("INSERT INTO repo (id, owner_id, name, visibility) VALUES ('pub', ?1, 'pub', 'public')", [u.value.id]);
  app.db.transaction(() => {
    for (let n = 1; n <= PULLS; n++) {
      const open = n % 2 === 0;
      app.db.run(
        "INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, 'pub', ?2, 'pull', 't', '', ?3, ?4, ?5)",
        [`p${n}`, n, u.value.id, open ? "open" : "closed", ago(100 + (n % 50))],
      );
      app.db.run("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES (?1, 'main', ?2, '', 'h')", [`p${n}`, `b${n}`]);
    }
    app.db.run(
      `WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < ?1)
       INSERT INTO event (id, kind, repo_id, payload, created_at)
       SELECT 'e' || i, 'pull.pushed', 'pub', json_object('number', 1 + i % ?2), ?3 FROM s`,
      [EVENTS, PULLS, ago(90)],
    );
  })();
});
afterAll(async () => {
  app.close?.();
  await rm(dir, { recursive: true, force: true });
});

test("the plan never scans event", () => {
  const plan = app.db
    .query<{ detail: string }, [number, string, number]>(`EXPLAIN QUERY PLAN ${IDLE_PULLS_SQL}`)
    .all(0, ago(72), 20)
    .map((r) => r.detail);
  expect(plan.filter((d) => /SCAN (e|event)\b/.test(d))).toEqual([]);
  expect(plan.some((d) => d.includes("event_repo_kind_number_at"))).toBe(true);
});

test("answers in one statement on a seeded forge", async () => {
  let rows: ReturnType<typeof readIdlePulls> = [];
  expectWork(await statements(app.db, () => void (rows = readIdlePulls(app.db, NOW, true))), { max: 1 });
  expect(rows.length).toBe(20);
  expect(rows[0]!.hours).toBeGreaterThanOrEqual(rows[19]!.hours);
});
