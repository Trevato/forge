/**
 * A page of pulls is worded from batched reads (#6151): `pullWords` gives the
 * word `pullWord` gives for every state, in few queries.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createIssue } from "../src/core/issues.ts";
import { listPulls, type Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { getUserByName } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { pullWord, pullWords, servingHistory, type WordCtx } from "../src/web/studio/words.ts";
import { quietLogs } from "./helpers/globals.ts";
import { adminCookie } from "./helpers/admin.ts";
import { expectWork } from "./helpers/work.ts";
import { statements } from "./helpers/statements.ts";

quietLogs();

describe("a page of pulls, worded in one batch", () => {
  let dataDir = "";
  let app: App;
  let repo: Repo;

  const ctx = (): WordCtx => ({
    db: app.db,
    dir: repoDir(app.reposRoot, repo.ownerName, repo.name),
    runtime: undefined,
    record: undefined,
    history: servingHistory(),
    viewer: undefined,
  });
  const page = (): Pull[] => listPulls(app.db, repo.id, { state: "all", limit: 100 });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-pulls-words-"));
    app = createApp({ dataDir, port: 0 });
    await adminCookie(app, { username: "alice", email: "alice@forge.test", password: "a-long-words-passphrase" });
    const alice = getUserByName(app.db, "alice")!;
    const made = await createRepo(app, alice, { name: "garden", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;

    // Rows go in directly: the words read the rows and the runs, not git.
    for (let i = 0; i < 50; i++) {
      const branch = `feature/p${i}`;
      const oid = String(i).padStart(2, "0").repeat(20);
      const issue = createIssue(app.db, { repoId: repo.id, authorId: alice.id, title: branch, body: "", kind: "pull" });
      if (!issue.ok) throw new Error(String(issue.error));
      const id = issue.value.id;
      app.db
        .query(
          `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id)
           VALUES (?1, 'main', ?2, ?3, ?3, ?4)`,
        )
        .run(id, branch, "f".repeat(40), repo.id);
      app.db.query("UPDATE pull SET head_oid = ?2 WHERE issue_id = ?1").run(id, oid);
      const check = (outcome: "ok" | "failed" | "running" | "queued") => {
        const c = createRun(app.db, { repoId: repo.id, kind: "check", issueId: id, env: `pull-${issue.value.number}`, commitOid: oid, reason: "pull" });
        if (outcome === "queued") return;
        claimRun(app.db, c.id);
        if (outcome !== "running") finishRun(app.db, c.id, { state: outcome, summary: outcome });
      };
      const state = i % 8;
      if (state === 1) check("ok");
      if (state === 2) check("failed");
      if (state === 3) check("running");
      if (state === 4) check("queued");
      if (state === 5) app.db.query("UPDATE issue SET state = 'closed', closed_at = datetime('now') WHERE id = ?1").run(id);
      if (state === 6) app.db.query("UPDATE issue SET state = 'closed', closed_at = datetime('now'), parked = 1 WHERE id = ?1").run(id);
      if (state === 7) {
        app.db.query("UPDATE issue SET state = 'closed', closed_at = datetime('now') WHERE id = ?1").run(id);
        app.db.query("UPDATE pull SET merged_at = datetime('now'), merged_oid = ?2 WHERE issue_id = ?1").run(id, oid);
      }
    }
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  test("every word is the one pullWord gives, for every state", async () => {
    const pulls = page();
    expect(pulls.length).toBe(50);
    const batched = await pullWords(ctx(), pulls);
    for (const [i, pull] of pulls.entries())
      expect(batched[i]).toEqual(await pullWord(ctx(), pull));
    const seen = new Set<string>(batched.map((w) => w.word));
    for (const w of ["waiting", "look", "stopped", "working", "shipped"]) expect(seen.has(w)).toBe(true);
    expect(batched.some((w) => w.note === "parked by the crew")).toBe(true);
    expect(batched.some((w) => w.note === "closed without shipping")).toBe(true);
  });

  test("a public app's production is read once for the page, and anyone may see it", async () => {
    const merged = page().filter((p) => p.mergedAt !== null);
    expect(merged.length).toBeGreaterThan(1);
    const [first, second] = merged as [Pull, Pull];
    let reads = 0;
    const runtime = (state: string) =>
      ({
        status: () => {
          reads++;
          return [{ env: "production", state, commitOid: first.mergedOid, error: "deploy broke" }];
        },
      }) as never;
    const record = { id: "app1", repoId: repo.id, access: "public" } as never;
    const at = (state: string): WordCtx => ({ ...ctx(), runtime: runtime(state), record });
    const caught = await pullWords(at("running"), [first]);
    expect(caught[0]).toEqual({ word: "shipped", note: "production is serving it" });
    const failing = at("failed");
    reads = 0;
    const batched = await pullWords(failing, merged);
    expect(reads).toBe(1);
    expect(batched[0]).toEqual({ word: "shipped", note: "production is serving it" });
    for (const [i, pull] of merged.entries()) expect(batched[i]).toEqual(await pullWord(at("failed"), pull));
    expect(second.mergedOid).not.toBe(first.mergedOid);
    expect(batched[1]).toEqual({ word: "waiting", note: "merged; waiting for production to redeploy" });
  });

  test("the words phase for 50 pulls costs a bounded number of statements", async () => {
    const pulls = page();
    await pullWords(ctx(), pulls); // warm statement caches
    const cost = await statements(app.db, async () => void (await pullWords(ctx(), pulls)));
    expectWork(cost, { max: 5 });
  });
});
