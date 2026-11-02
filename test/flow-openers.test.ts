/** Who opened the last hour's pulls (#6443). */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { id } from "../src/kernel/id.ts";
import { readOpeners } from "../src/flow/openers.ts";

const NOW = new Date("2026-10-26T12:00:00.000Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

describe("readOpeners", () => {
  let dir: string;
  let app: App;
  let users: Record<string, string>;
  let pub: string;
  let priv: string;
  let n = 0;

  const repo = (name: string, visibility: string, owner: string) => {
    const rid = id();
    app.db.query(`INSERT INTO repo (id, owner_id, name, visibility) VALUES (?1, ?2, ?3, ?4)`).run(rid, owner, name, visibility);
    return rid;
  };
  const issue = (repoId: string, number: number, author: string, kind = "issue", body = "", at = ago(600)) => {
    const iid = id();
    app.db
      .query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, created_at) VALUES (?1, ?2, ?3, ?4, 't', ?5, ?6, ?7)`)
      .run(iid, repoId, number, kind, body, author, at);
    return iid;
  };
  const pull = (repoId: string, author: string, body: string, min: number) => {
    const iid = issue(repoId, 100000 + ++n, author, "pull", body, ago(min));
    app.db.query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES (?1, 'main', ?2, '', '')`).run(iid, `b/${n}`);
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "forge-openers-"));
    app = createApp({ dataDir: dir, port: 0 });
    users = {};
    for (const name of ["alice", "bob"]) {
      const u = await createUser(app.db, { username: name, email: `${name}@forge.test`, password: "a-good-passphrase", origin: "seed", trusted: true });
      if (!u.ok) throw new Error(u.error);
      users[name] = u.value.id;
    }
    pub = repo("pub", "public", users.alice!);
    priv = repo("priv", "private", users.alice!);
  });
  afterEach(() => {
    app.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("counts two authors, most first, and marks the pulls that serve a flow issue", () => {
    issue(pub, 5930, users.alice!);
    pull(pub, users.bob!, "Closes #5930", 5);
    pull(pub, users.bob!, "Closes #1", 10);
    pull(pub, users.bob!, "", 15);
    pull(pub, users.alice!, "Fixes #6217", 20);
    issue(pub, 6217, users.alice!);
    expect(readOpeners(app.db, NOW)).toEqual([
      { author: "bob", opened: 3, flow: 1 },
      { author: "alice", opened: 1, flow: 1 },
    ]);
  });

  test("a pull whose issue waits on a flow issue, however far, is flow", () => {
    const root = issue(pub, 5994, users.alice!);
    const mid = issue(pub, 20, users.alice!);
    const leaf = issue(pub, 21, users.alice!);
    issue(pub, 22, users.alice!);
    const dep = (a: string, b: string) => app.db.query(`INSERT INTO issue_dependency (issue_id, blocked_by_id) VALUES (?1, ?2)`).run(a, b);
    dep(mid, root);
    dep(leaf, mid);
    pull(pub, users.bob!, "Closes #21", 3);
    pull(pub, users.bob!, "Closes #22", 4);
    expect(readOpeners(app.db, NOW)).toEqual([{ author: "bob", opened: 2, flow: 1 }]);
  });

  test("a pull closing a flow-labelled issue in another repository is flow; an unlabelled one is not", () => {
    const other = repo("other", "public", users.alice!);
    const tagged = issue(other, 7, users.alice!);
    issue(other, 8, users.alice!);
    const lid = id();
    app.db.query(`INSERT INTO label (id, repo_id, name) VALUES (?1, ?2, 'Flow')`).run(lid, other);
    app.db.query(`INSERT INTO issue_label (issue_id, label_id) VALUES (?1, ?2)`).run(tagged, lid);
    pull(other, users.bob!, "Closes #7", 3);
    pull(other, users.bob!, "Closes #8", 4);
    expect(readOpeners(app.db, NOW)).toEqual([{ author: "bob", opened: 2, flow: 1 }]);
  });

  test("a pull opened 61 minutes ago is left out, 59 is in", () => {
    pull(pub, users.bob!, "", 61);
    pull(pub, users.alice!, "", 59);
    expect(readOpeners(app.db, NOW)).toEqual([{ author: "alice", opened: 1, flow: 0 }]);
  });

  test("publicOnly hides private repositories", () => {
    pull(pub, users.alice!, "", 5);
    pull(priv, users.bob!, "", 5);
    expect(readOpeners(app.db, NOW).map((o) => o.author)).toEqual(["alice", "bob"]);
    expect(readOpeners(app.db, NOW, true)).toEqual([{ author: "alice", opened: 1, flow: 0 }]);
  });
});
