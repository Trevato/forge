/** The crew's build yield over 24 hours (#6474). */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { id } from "../src/kernel/id.ts";
import { readBuildYield } from "../src/flow/build_yield.ts";

const NOW = new Date("2026-10-26T12:00:00.000Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

describe("readBuildYield", () => {
  let dir: string;
  let app: App;
  let owner: string;
  let pub: string;
  let priv: string;
  let n = 0;

  const repo = (name: string, visibility: string) => {
    const rid = id();
    app.db.query(`INSERT INTO repo (id, owner_id, name, visibility) VALUES (?1, ?2, ?3, ?4)`).run(rid, owner, name, visibility);
    return rid;
  };
  const run = (repoId: string, branch: string, start: number, end: number, reason = "") => {
    app.db
      .query(`INSERT INTO run (id, repo_id, kind, branch, state, reason, started_at, finished_at) VALUES (?1, ?2, 'agent', ?3, 'ok', ?4, ?5, ?6)`)
      .run(id(), repoId, branch, reason, ago(start), ago(end));
  };
  /** A pull on `branch`, with one event of `kind` `at` minutes ago. */
  const pull = (repoId: string, branch: string, at: number, state: "open" | "merged" | "closed", kind = "pull.pushed") => {
    const iid = id();
    const number = ++n;
    app.db
      .query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, ?3, 'pull', 't', '', ?4, ?5, ?6)`)
      .run(iid, repoId, number, owner, state === "closed" ? "closed" : "open", ago(1000));
    app.db
      .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at) VALUES (?1, 'main', ?2, '', '', ?3)`)
      .run(iid, branch, state === "merged" ? ago(1) : null);
    app.db.query(`INSERT INTO event (id, kind, repo_id, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`).run(id(), kind, repoId, JSON.stringify({ number }), ago(at));
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "forge-yield-"));
    app = createApp({ dataDir: dir, port: 0 });
    const u = await createUser(app.db, { username: "alice", email: "alice@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true });
    if (!u.ok) throw new Error(u.error);
    owner = u.value.id;
    pub = repo("pub", "public");
    priv = repo("priv", "private");
  });
  afterEach(() => {
    app.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("counts a run that merged, one still open, one closed and one that never pushed", () => {
    run(pub, "a", 60, 50);
    pull(pub, "a", 55, "merged");
    run(pub, "b", 60, 50);
    pull(pub, "b", 55, "open", "pull.opened");
    run(pub, "c", 60, 50);
    pull(pub, "c", 55, "closed");
    run(pub, "d", 60, 50);
    expect(readBuildYield(app.db, NOW)).toEqual({ finished: 4, pushed: 3, landed: 1, closed: 1 });
  });

  test("a push outside the run's span does not count, nor does a review run", () => {
    run(pub, "a", 60, 50);
    pull(pub, "a", 40, "merged");
    run(pub, "r", 60, 50, "review");
    pull(pub, "r", 55, "merged");
    expect(readBuildYield(app.db, NOW)).toEqual({ finished: 1, pushed: 0, landed: 0, closed: 0 });
  });

  test("a run that finished 25 hours ago is left out, 23 is in", () => {
    run(pub, "old", 25 * 60 + 10, 25 * 60);
    run(pub, "new", 23 * 60 + 10, 23 * 60);
    expect(readBuildYield(app.db, NOW).finished).toBe(1);
  });

  test("two runs on one pull push twice and land it once", () => {
    run(pub, "a", 60, 50);
    run(pub, "a", 40, 30);
    pull(pub, "a", 55, "merged");
    app.db.query(`INSERT INTO event (id, kind, repo_id, payload, created_at) VALUES (?1, 'pull.pushed', ?2, ?3, ?4)`).run(id(), pub, JSON.stringify({ number: n }), ago(35));
    expect(readBuildYield(app.db, NOW)).toEqual({ finished: 2, pushed: 2, landed: 1, closed: 0 });
  });

  test("publicOnly hides private repositories", () => {
    run(pub, "a", 60, 50);
    run(priv, "p", 60, 50);
    pull(priv, "p", 55, "merged");
    expect(readBuildYield(app.db, NOW)).toEqual({ finished: 2, pushed: 1, landed: 1, closed: 0 });
    expect(readBuildYield(app.db, NOW, true)).toEqual({ finished: 1, pushed: 0, landed: 0, closed: 0 });
  });
});
