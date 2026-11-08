/** The checks pile (#5930): open pulls red on their current head, and those with a check queued. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { id } from "../src/kernel/id.ts";
import { readChecksPile } from "../src/flow/checks_pile.ts";

let root: string;
let app: App;
let ownerId: string;
let pub: string;
let priv: string;
let n = 0;
let seq = 0;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-checks-pile-"));
  app = createApp({ dataDir: root, port: 0 });
  const made = await createUser(app.db, { username: "trevato", email: "t@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true, adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  ownerId = made.value.id;
  for (const [name, visibility] of [["open", "public"], ["secret", "private"]] as const) {
    const repo = await createRepo(app.db, app.reposRoot, { ownerId, name, visibility, description: "r" });
    if (!repo.ok) throw new Error(repo.error);
    if (name === "open") pub = repo.value.id;
    else priv = repo.value.id;
  }
});
afterAll(() => {
  app.close();
  rmSync(root, { recursive: true, force: true });
});

function pull(repoId: string, head: string, opts: { merged?: boolean } = {}): string {
  const issue = id();
  app.db
    .query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state) VALUES (?1, ?2, ?3, 'pull', 't', '', ?4, ?5)`)
    .run(issue, repoId, ++n, ownerId, opts.merged ? "closed" : "open");
  app.db
    .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id, merged_at) VALUES (?1, 'main', 'b', '', ?2, ?3, ?4)`)
    .run(issue, head, repoId, opts.merged ? "2026-10-26T00:00:00.000Z" : null);
  return issue;
}
function check(repoId: string, issue: string, oid: string, state: string): void {
  app.db
    .query(`INSERT INTO run (id, repo_id, kind, issue_id, commit_oid, state) VALUES (?1, ?2, 'check', ?3, ?4, ?5)`)
    .run(`${String(++seq).padStart(4, "0")}${id()}`, repoId, issue, oid, state);
}
const clear = (): void => {
  app.db.query(`DELETE FROM run`).run();
  app.db.query(`DELETE FROM pull`).run();
  app.db.query(`DELETE FROM issue`).run();
};

describe("checks pile", () => {
  test("nothing yet reads zero", () => {
    expect(readChecksPile(app.db)).toEqual({ red: 0, queued: 0 });
  });

  test("a red pull counts; red on an older head, green on the current, does not", () => {
    clear();
    const a = pull(pub, "h1");
    check(pub, a, "h1", "failed");
    const b = pull(pub, "h2");
    check(pub, b, "h1", "failed");
    check(pub, b, "h2", "ok");
    expect(readChecksPile(app.db)).toEqual({ red: 1, queued: 0 });
  });

  test("a red run on the old head does not count when the current head has none", () => {
    clear();
    check(pub, pull(pub, "h2"), "h1", "failed");
    expect(readChecksPile(app.db).red).toBe(0);
  });

  test("a later green on the same head clears red", () => {
    clear();
    const a = pull(pub, "h1");
    check(pub, a, "h1", "failed");
    check(pub, a, "h1", "ok");
    expect(readChecksPile(app.db).red).toBe(0);
  });

  test("a merged pull is not counted", () => {
    clear();
    const a = pull(pub, "h1", { merged: true });
    check(pub, a, "h1", "failed");
    check(pub, a, "h1", "queued");
    expect(readChecksPile(app.db)).toEqual({ red: 0, queued: 0 });
  });

  test("a queued check is counted once, even with two queued", () => {
    clear();
    const a = pull(pub, "h1");
    check(pub, a, "h1", "queued");
    check(pub, a, "h1", "queued");
    expect(readChecksPile(app.db)).toEqual({ red: 0, queued: 1 });
  });

  test("publicOnly hides private repositories", () => {
    clear();
    check(priv, pull(priv, "p1"), "p1", "failed");
    check(priv, pull(priv, "p2"), "p2", "queued");
    check(pub, pull(pub, "h1"), "h1", "failed");
    expect(readChecksPile(app.db)).toEqual({ red: 2, queued: 1 });
    expect(readChecksPile(app.db, true)).toEqual({ red: 1, queued: 0 });
  });
});
