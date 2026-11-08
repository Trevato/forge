/**
 * The closed pulls list is worded as fast as the open one (#8388): a page of
 * 50 merged and closed pulls, each with a check and a review, reads its words
 * after production moves on by growing the ancestry production's new commit
 * needs from the one already kept, one short git walk per deploy rather than
 * the whole history again — and every word is still the one `pullWord` gives.
 * The counters prove the short walk; time is only a loose sanity bound.
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
import { submitReview } from "../src/core/reviews.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { getUserByName } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { AncestryCache } from "../src/web/studio/ancestry.ts";
import { pullWord, pullWords, servingHistory, type WordCtx } from "../src/web/studio/words.ts";
import { quietLogs } from "./helpers/globals.ts";
import { adminCookie } from "./helpers/admin.ts";

quietLogs();

const HISTORY = 3000;

/** A linear history of `n` empty commits on main, oldest first, in one spawn. */
async function seedHistory(dir: string, n: number): Promise<string[]> {
  let stream = "";
  for (let i = 1; i <= n; i++) {
    const msg = `c${i}`;
    stream += `commit refs/heads/main\nmark :${i}\ncommitter a <a@forge.test> ${1_700_000_000 + i} +0000\ndata ${msg.length}\n${msg}\n`;
    if (i > 1) stream += `from :${i - 1}\n`;
    stream += "\n";
  }
  const imp = Bun.spawn(["git", "fast-import", "--quiet"], { cwd: dir, stdin: "pipe", stdout: "ignore", stderr: "pipe" });
  imp.stdin.write(stream);
  await imp.stdin.end();
  expect(await imp.exited).toBe(0);
  const list = Bun.spawn(["git", "rev-list", "--reverse", "main"], { cwd: dir, stdout: "pipe" });
  const out = await new Response(list.stdout).text();
  expect(await list.exited).toBe(0);
  return out.trim().split("\n");
}

describe("a page of closed and merged pulls, worded in one batch", () => {
  let dataDir = "";
  let app: App;
  let repo: Repo;
  let oids: string[] = [];
  let production = "";
  // The test's own cache, so no other file's reads move its counts.
  const ancestries = new AncestryCache(400_000);

  const runtime = {
    status: () => [{ env: "production", state: "running", commitOid: production }],
  } as never;
  const ctx = (): WordCtx => ({
    db: app.db,
    dir: repoDir(app.reposRoot, repo.ownerName, repo.name),
    runtime,
    record: { id: "app1", repoId: repo.id, access: "public" } as never,
    history: servingHistory(),
    viewer: undefined,
    ancestries,
  });
  const page = (): Pull[] => listPulls(app.db, repo.id, { state: "closed", limit: 50 });
  /** The answer the commit order gives: a merge is served once production is at or past it. */
  const shippedAt = (prod: string, pulls: readonly Pull[]) =>
    pulls.filter((p) => p.mergedOid !== null && oids.indexOf(p.mergedOid) <= oids.indexOf(prod)).length;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-words-closed-"));
    app = createApp({ dataDir, port: 0 });
    await adminCookie(app, { username: "alice", email: "alice@forge.test", password: "a-long-words-passphrase" });
    const alice = getUserByName(app.db, "alice")!;
    const made = await createRepo(app, alice, { name: "landed", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    oids = await seedHistory(repoDir(app.reposRoot, repo.ownerName, repo.name), HISTORY);

    for (let i = 0; i < 50; i++) {
      const branch = `feature/p${i}`;
      // Merged pulls land among the last 60 commits, so a production a few
      // commits back serves some of them and not the rest.
      const head = oids[HISTORY - 60 + i]!;
      const issue = createIssue(app.db, { repoId: repo.id, authorId: alice.id, title: branch, body: "", kind: "pull" });
      if (!issue.ok) throw new Error(String(issue.error));
      const id = issue.value.id;
      app.db
        .query(
          `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id)
           VALUES (?1, 'main', ?2, ?3, ?4, ?5)`,
        )
        .run(id, branch, oids[0]!, head, repo.id);
      const check = createRun(app.db, { repoId: repo.id, kind: "check", issueId: id, env: `pull-${issue.value.number}`, commitOid: head, reason: "pull" });
      claimRun(app.db, check.id);
      finishRun(app.db, check.id, { state: i % 5 === 0 ? "failed" : "ok", summary: "checked" });
      const review = submitReview(app.db, { issueId: id, authorId: alice.id, state: "approved", commitOid: head });
      if (!review.ok) throw new Error(String(review.error));
      if (i % 2 === 0) {
        app.db.query("UPDATE issue SET state = 'closed', closed_at = datetime('now') WHERE id = ?1").run(id);
        app.db.query("UPDATE pull SET merged_at = datetime('now'), merged_oid = ?2 WHERE issue_id = ?1").run(id, head);
      } else {
        app.db
          .query("UPDATE issue SET state = 'closed', closed_at = datetime('now'), parked = ?2 WHERE id = ?1")
          .run(id, i % 3 === 0 ? 1 : 0);
      }
    }
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  test("after a deploy the page's words grow from the kept ancestry, each the one pullWord gives", async () => {
    const pulls = page();
    expect(pulls.length).toBe(50);
    expect(pulls.filter((p) => p.mergedAt !== null).length).toBe(25);

    // The first page after boot walks the whole history once.
    production = oids[HISTORY - 40]!;
    const first = await pullWords(ctx(), pulls);
    expect(first.filter((w) => w.word === "shipped").length).toBe(shippedAt(production, pulls));

    expect(ancestries.reads).toBe(1);
    expect(ancestries.grown).toBe(0);

    // Then production moves on, a deploy at a time: each new commit is a
    // miss, answered from the kept ancestry plus the commits since.
    const timings: number[] = [];
    const steps = [HISTORY - 30, HISTORY - 25, HISTORY - 20, HISTORY - 15, HISTORY - 10, HISTORY - 6, HISTORY - 3, HISTORY - 1];
    for (const step of steps) {
      production = oids[step]!;
      const at = performance.now();
      const words = await pullWords(ctx(), pulls);
      timings.push(performance.now() - at);
      expect(words.filter((w) => w.word === "shipped").length).toBe(shippedAt(production, pulls));
      for (const [i, pull] of pulls.entries()) expect(words[i]).toEqual(await pullWord(ctx(), pull));
    }
    expect(ancestries.reads).toBe(1 + steps.length); // one short walk per deploy
    expect(ancestries.grown).toBe(steps.length);
    // A loose sanity bound only; the counts above are the proof.
    expect(timings.reduce((a, b) => a + b, 0)).toBeLessThan(2000);

    const last = await pullWords(ctx(), pulls);
    expect(last.filter((w) => w.word === "shipped").length).toBe(25);
    expect(last.filter((w) => w.note === "parked by the crew").length).toBeGreaterThan(0);
    expect(last.filter((w) => w.note === "closed without shipping").length).toBeGreaterThan(0);
  });
});
