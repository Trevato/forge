/**
 * Counts without N+1.
 *
 * Two things are proved here. First that the grouped helpers agree exactly
 * with the per-row functions they replace — a faster wrong number is worse
 * than a slow right one. Second that the number of SQL statements a listing
 * costs does not grow with the number of rows it returns, which is the only
 * definition of "no N+1" that survives someone adding a field later.
 *
 * The seed goes in as plain rows rather than through the repo actions: this
 * is a test about queries, and two hundred `git init --bare` runs would make
 * it a test about the filesystem.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signUp } from "../src/actions/users.ts";
import { createApp, type App } from "../src/app.ts";
import {
  addComment,
  commentCounts,
  countIssues,
  createLabel,
  labelsFor,
  labelsForIssues,
  setIssueLabels,
} from "../src/core/issues.ts";
import { countsForRepos, listReposVisibleTo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { id } from "../src/kernel/id.ts";
import { unwrap } from "../src/kernel/result.ts";

/**
 * Count the SQL statements a block of work runs. `db.query` is the one door
 * every read and write in the forge goes through, so wrapping it counts
 * statements without threading a counter through the code under test.
 */
async function statements(db: Database, work: () => Promise<void> | void) {
  const original = db.query.bind(db);
  let count = 0;
  const seen: string[] = [];
  (db as unknown as { query: unknown }).query = (sql: string) => {
    count++;
    seen.push(sql.replace(/\s+/g, " ").trim().slice(0, 80));
    return original(sql);
  };
  try {
    await work();
  } finally {
    (db as unknown as { query: unknown }).query = original;
  }
  return { count, seen };
}

describe("counts are grouped, and stay grouped", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let token = "";
  const repoIds: string[] = [];

  const seedRepo = (name: string, visibility: "public" | "private") => {
    const repoId = id();
    app.db
      .query(
        `INSERT INTO repo (id, owner_id, name, visibility, description, default_branch)
         VALUES (?1, ?2, ?3, ?4, ?5, 'main')`,
      )
      .run(repoId, alice.id, name, visibility, `the ${name} repo`);
    repoIds.push(repoId);
    return repoId;
  };

  const seedIssue = (
    repoId: string,
    number: number,
    kind: "issue" | "pull",
    state: "open" | "closed",
    title = `${kind} ${number}`,
  ) => {
    const issueId = id();
    app.db
      .query(
        `INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state)
         VALUES (?1, ?2, ?3, ?4, ?5, '', ?6, ?7)`,
      )
      .run(issueId, repoId, number, kind, title, alice.id, state);
    return issueId;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-counts-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;

    alice = unwrap(
      await signUp(app, {
        username: "alice",
        email: "alice@forge.test",
        password: "alice-counts-secret",
      }),
    );
    token = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adminConfirm: true,
        username: "alice",
        password: "alice-counts-secret",
        name: "t",
        scope: "rw",
      }),
    })
      .then((r) => r.json())
      .then((j) => (j as { token: string }).token);

    // 200 repos, each with a different mix of open and closed work.
    for (let i = 0; i < 200; i++) {
      const repoId = seedRepo(`repo-${String(i).padStart(3, "0")}`, "public");
      let number = 0;
      for (let n = 0; n < i % 5; n++)
        seedIssue(repoId, ++number, "issue", "open");
      for (let n = 0; n < i % 3; n++)
        seedIssue(repoId, ++number, "pull", "open");
      // Closed work must not be counted, so there is always some of it.
      seedIssue(repoId, ++number, "issue", "closed");
      seedIssue(repoId, ++number, "pull", "closed");
    }
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the grouped counts equal the per-row counts, everywhere", () => {
    const grouped = countsForRepos(app.db, repoIds);
    for (const repoId of repoIds) {
      expect(grouped.get(repoId)).toEqual({
        openIssues: countIssues(app.db, repoId, "issue", "open"),
        openPulls: countIssues(app.db, repoId, "pull", "open"),
      });
    }
  });

  test("a repo with nothing open counts zero rather than going missing", () => {
    const empty = seedRepo("silent", "public");
    expect(countsForRepos(app.db, [empty]).get(empty)).toEqual({
      openIssues: 0,
      openPulls: 0,
    });
    expect(countsForRepos(app.db, []).size).toBe(0);
  });

  test("a repo listing costs the same whether it returns 10 rows or 200", async () => {
    const small = await statements(app.db, () => {
      listReposVisibleTo(app.db, alice, { limit: 10 });
    });
    const large = await statements(app.db, () => {
      listReposVisibleTo(app.db, alice, { limit: 200 });
    });
    expect(large.count).toBe(small.count);
    // The list, and one grouped count for the page. Nothing per row.
    expect(large.count).toBeLessThanOrEqual(3);
    expect(large.seen.length).toBe(large.count);
  });

  test("the repo list API carries counts, and does not pay per row", async () => {
    const listed = await statements(app.db, async () => {
      const response = await fetch(`${base}/api/v1/repos?limit=200`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await response.json()) as {
        items: {
          id: string;
          counts: { openIssues: number; openPulls: number };
        }[];
      };
      expect(body.items.length).toBe(200);
      for (const repo of body.items) {
        expect(repo.counts).toEqual(
          countsForRepos(app.db, [repo.id]).get(repo.id)!,
        );
      }
    });
    // The assertions above run 200 count queries of their own; what matters
    // is that the request itself is measured separately.
    expect(listed.count).toBeGreaterThan(0);

    const ten = await statements(app.db, async () => {
      await fetch(`${base}/api/v1/repos?limit=10`, {
        headers: { authorization: `Bearer ${token}` },
      }).then((r) => r.json());
    });
    const twoHundred = await statements(app.db, async () => {
      await fetch(`${base}/api/v1/repos?limit=200`, {
        headers: { authorization: `Bearer ${token}` },
      }).then((r) => r.json());
    });
    expect(twoHundred.count).toBe(ten.count);
  });

  test("a single repo still reports its counts", async () => {
    const response = await fetch(`${base}/api/v1/repos/alice/repo-004`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const repo = (await response.json()) as {
      id: string;
      counts: { openIssues: number; openPulls: number };
    };
    expect(repo.counts).toEqual({
      openIssues: countIssues(app.db, repo.id, "issue", "open"),
      openPulls: countIssues(app.db, repo.id, "pull", "open"),
    });
  });

  test("grouped labels and comment counts equal the per-row ones", () => {
    const repoId = repoIds[0]!;
    const bug = unwrap(createLabel(app.db, repoId, "bug", "ff0000"));
    const chore = unwrap(createLabel(app.db, repoId, "chore", "00ff00"));

    const ids: string[] = [];
    for (let n = 0; n < 30; n++) {
      const issueId = seedIssue(repoId, 1000 + n, "issue", "open");
      ids.push(issueId);
      setIssueLabels(
        app.db,
        issueId,
        n % 3 === 0 ? [bug.id, chore.id] : n % 3 === 1 ? [bug.id] : [],
      );
      for (let c = 0; c < n % 4; c++) {
        unwrap(
          addComment(app.db, {
            issueId,
            authorId: alice.id,
            body: `comment ${c}`,
          }),
        );
      }
    }

    const labels = labelsForIssues(app.db, ids);
    const comments = commentCounts(app.db, ids);
    for (const issueId of ids) {
      expect(labels.get(issueId) ?? []).toEqual(labelsFor(app.db, issueId));
      expect(comments.get(issueId) ?? 0).toBe(
        app.db
          .query<
            { n: number },
            [string]
          >("SELECT COUNT(*) AS n FROM comment WHERE issue_id = ?1 AND kind = 'comment'")
          .get(issueId)!.n,
      );
    }
  });

  test("an issue listing costs the same for 5 rows as for 50", async () => {
    const repoId = repoIds[0]!;
    for (let n = 0; n < 60; n++) seedIssue(repoId, 2000 + n, "issue", "open");

    const five = await statements(app.db, async () => {
      await fetch(`${base}/api/v1/repos/alice/repo-000/issues?limit=5`, {
        headers: { authorization: `Bearer ${token}` },
      }).then((r) => r.json());
    });
    const fifty = await statements(app.db, async () => {
      const body = (await fetch(
        `${base}/api/v1/repos/alice/repo-000/issues?limit=50`,
        { headers: { authorization: `Bearer ${token}` } },
      ).then((r) => r.json())) as {
        items: { labels: unknown[]; comments: number }[];
      };
      expect(body.items.length).toBe(50);
      // The grouped shape is what the client sees, not just what we ran.
      expect(body.items[0]).toHaveProperty("labels");
      expect(body.items[0]).toHaveProperty("comments");
    });
    expect(fifty.count).toBe(five.count);
    expect(repoId).toBe(repoIds[0]!);
  });
});
