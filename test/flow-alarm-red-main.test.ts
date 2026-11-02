/** The red-main flow alarm (#6343): fires at 10 min of red, names the failing test; green or fresh red does not fire. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { id } from "../src/kernel/id.ts";
import { redMainAlarm } from "../src/flow/alarm_red_main.ts";

const NOW = new Date("2026-10-26T12:00:00.000Z");
const ago = (min: number): string => new Date(NOW.getTime() - min * 60_000).toISOString();

let root: string;
let app: App;
let repoId: string;
let branch: string;
let n = 0;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-alarm-red-"));
  app = createApp({ dataDir: root, port: 0 });
  const made = await createUser(app.db, { username: "trevato", email: "t@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true, adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  const repo = await createRepo(app.db, app.reposRoot, { ownerId: made.value.id, name: "forge", visibility: "public", description: "f" });
  if (!repo.ok) throw new Error(repo.error);
  repoId = repo.value.id;
  branch = repo.value.defaultBranch;
});
afterAll(() => {
  app.close();
  rmSync(root, { recursive: true, force: true });
});

function check(state: "ok" | "failed", finishedMinAgo: number, names: string[] = []): void {
  // ids sort in insertion order
  app.db
    .query(`INSERT INTO run (id, repo_id, kind, env, state, summary, check_detail, created_at, finished_at) VALUES (?1, ?2, 'check', ?3, ?4, ?5, ?6, ?7, ?7)`)
    .run(`${String(++n).padStart(4, "0")}${id()}`, repoId, branch, state, state === "ok" ? "ok" : "check failed", JSON.stringify({ names }), ago(finishedMinAgo));
}
const clear = (): void => void app.db.query(`DELETE FROM run`).run();

describe("red main alarm", () => {
  test("no check yet does not fire", () => {
    expect(redMainAlarm(app.db, NOW).fired).toBe(false);
  });

  test("red for 11 min fires and names the test", () => {
    clear();
    check("failed", 11, ["test/standards.test.ts"]);
    const a = redMainAlarm(app.db, NOW);
    expect(a.fired).toBe(true);
    expect(a.since).toBe(ago(11));
    expect(a.says).toBe("Main has been red for 11 min: test/standards.test.ts.");
  });

  test("red for 9 min does not fire", () => {
    clear();
    check("failed", 9, ["x.test.ts"]);
    expect(redMainAlarm(app.db, NOW).fired).toBe(false);
  });

  test("green does not fire, even after an old red", () => {
    clear();
    check("failed", 60);
    check("ok", 5);
    expect(redMainAlarm(app.db, NOW)).toEqual({ fired: false, says: "Main is green." });
  });

  test("the streak counts from the first red after the last green", () => {
    clear();
    check("ok", 90);
    check("failed", 25, ["a.test.ts"]);
    check("failed", 3, ["a.test.ts"]);
    const a = redMainAlarm(app.db, NOW);
    expect(a.fired).toBe(true);
    expect(a.says).toBe("Main has been red for 25 min: a.test.ts.");
  });

  test("a pull's red check is not main's", () => {
    clear();
    const issue = id();
    app.db.query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, 1, 'pull', 'p', '', (SELECT id FROM user LIMIT 1), 'open', ?3)`).run(issue, repoId, ago(100));
    app.db.query(`INSERT INTO run (id, repo_id, kind, issue_id, env, state, created_at, finished_at) VALUES ('zzz1', ?1, 'check', ?2, ?3, 'failed', ?4, ?4)`).run(repoId, issue, branch, ago(30));
    expect(redMainAlarm(app.db, NOW).fired).toBe(false);
  });
});
