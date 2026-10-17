/**
 * The restore drill counts users, pulls and apps as well as repositories and
 * issues (#2145), and a count that cannot be read is red at `count`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enableApp } from "../src/actions/apps.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createIssue } from "../src/core/issues.ts";
import { createUser } from "../src/core/users.ts";
import { runDrill } from "../src/snapshot/drill.ts";
import { lastDrill, recordDrill } from "../src/snapshot/drills.ts";
import { takeSnapshot } from "../src/snapshot/snapshot.ts";
import { dirStore } from "../src/snapshot/store.ts";

describe("the restore drill's counts", () => {
  let root: string;
  let app: App;
  const snap = (name: string, at: string) =>
    takeSnapshot(
      {
        db: app.db,
        dataDir: app.config.dataDir,
        reposRoot: app.reposRoot,
        version: "t",
      },
      dirStore(join(root, name)),
      new Date(at),
    );
  const drill = (name: string) =>
    runDrill({
      store: dirStore(join(root, name)),
      dataDir: join(root, "drill-data"),
      boot: async () => ({ ok: true, reason: "" }),
    });

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "forge-drill-counts-"));
    app = createApp({ dataDir: join(root, "live"), port: 0 });
    const users = [];
    for (const name of ["alice", "bob"]) {
      const u = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username: name,
        email: `${name}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: name === "alice",
      });
      if (!u.ok) throw new Error(u.error);
      users.push(u.value);
    }
    const repos = [];
    for (const name of ["one", "two", "three"]) {
      const r = await createRepo(app, users[0]!, { name, visibility: "private" });
      if (!r.ok) throw new Error(String(r.error));
      repos.push(r.value);
    }
    const issue = createIssue(app.db, {
      repoId: repos[0]!.id,
      authorId: users[0]!.id,
      title: "a pull",
      kind: "pull",
    });
    if (!issue.ok) throw new Error(issue.error);
    app.db
      .query(
        `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid)
         VALUES (?1, 'main', 'topic', 'a', 'b')`,
      )
      .run(issue.value.id);
    const enabled = enableApp(app, users[0]!, repos[0]!);
    if (!enabled.ok) throw new Error(String(enabled.error));
    await snap("good", "2026-09-22T08:00:00Z");

    app.db.exec("PRAGMA foreign_keys = OFF; DROP TABLE pull;");
    await snap("nopulls", "2026-09-23T08:00:00Z");
  });

  afterAll(async () => {
    app.close();
    await rm(root, { recursive: true, force: true });
  });

  test("2 users, 3 repositories, 1 pull and 1 app are counted exactly", async () => {
    const r = await drill("good");
    expect(r.verdict).toBe("green");
    expect(r.counts).toMatchObject({ users: 2, repositories: 3, pulls: 1, apps: 1 });
  });

  test("a restored database without the pulls table is red at count, not a note on green", async () => {
    const r = await drill("nopulls");
    expect(r.verdict).toBe("red");
    expect(r.failedStep).toBe("count");
    expect(r.reason).toContain("pull");
  });

  test("a drill row keeps all five counts", async () => {
    const r = await drill("good");
    recordDrill(app.db, r);
    expect(lastDrill(app.db)?.counts).toEqual(r.counts);
  });
});
