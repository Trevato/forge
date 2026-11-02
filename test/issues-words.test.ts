/**
 * A page of issues is worded from batched reads (#6125): `tellWords` gives the
 * word `tellWord` gives for every state, and its queries stay constant as the page grows.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createIssue, listIssues, setAssignee, type Issue } from "../src/core/issues.ts";
import { openPullsClosing } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { getUserByName } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { tellWord, tellWords } from "../src/web/studio/tell.ts";
import { servingHistory, type WordCtx } from "../src/web/studio/words.ts";
import { quietLogs } from "./helpers/globals.ts";
import { adminCookie } from "./helpers/admin.ts";

quietLogs();

describe("a page of issues, worded in one batch", () => {
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
  const page = (): Issue[] => listIssues(app.db, repo.id, { kind: "issue", state: "all", limit: 100 });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-issues-words-"));
    app = createApp({ dataDir, port: 0 });
    await adminCookie(app, { username: "alice", email: "alice@forge.test", password: "a-long-words-passphrase" });
    const alice = getUserByName(app.db, "alice")!;
    const made = await createRepo(app, alice, { name: "garden", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    await commitToBranch(app, alice, repo, { message: "seed", files: [{ path: "README.md", content: "# garden\n" }] });

    for (let i = 0; i < 50; i++) {
      const issue = createIssue(app.db, { repoId: repo.id, authorId: alice.id, title: `Thing ${i}` });
      if (!issue.ok) throw new Error(String(issue.error));
      const it = issue.value;
      const state = i % 10;
      const run = (extra: Record<string, unknown>) =>
        createRun(app.db, { repoId: repo.id, kind: "agent", issueId: it.id, ...extra });
      const pullFor = async (branch: string, body: string) => {
        await commitToBranch(app, alice, repo, { branch, base: "main", message: branch, files: [{ path: `${branch.replace("/", "-")}.md`, content: "x\n" }] });
        const opened = await openPull(app, alice, repo, { title: branch, body, baseBranch: "main", headBranch: branch });
        if (!opened.ok) throw new Error(String(opened.error));
        return opened.value;
      };
      if (i === 0) {
        const r = run({});
        claimRun(app.db, r.id);
        finishRun(app.db, r.id, { state: "ok", summary: "looked" });
      }
      if (state === 1) setAssignee(app.db, it.id, alice.id);
      if (state === 2) claimRun(app.db, run({}).id);
      if (state === 3) run({});
      if (state === 4) {
        await pullFor(`bot/p${i}`, "");
        const r = run({ branch: `bot/p${i}` });
        claimRun(app.db, r.id);
        finishRun(app.db, r.id, { state: "ok", summary: "ok" });
      }
      if (state === 5) {
        const r = run({});
        claimRun(app.db, r.id);
        finishRun(app.db, r.id, { state: "failed", summary: "broke" });
      }
      if (state === 6 || state === 7) {
        const pull = await pullFor(`feature/c${i}`, `Closes #${it.number}`);
        if (state === 6) {
          const c = createRun(app.db, { repoId: repo.id, kind: "check", issueId: pull.id, env: `pull-${pull.number}`, commitOid: pull.headOid, reason: "pull" });
          claimRun(app.db, c.id);
          finishRun(app.db, c.id, { state: "ok", summary: "ok" });
        }
      }
      if (state === 8) app.db.query("UPDATE issue SET state = 'closed', closed_at = datetime('now') WHERE id = ?1").run(it.id);
      if (state === 9) {
        const pull = await pullFor(`feature/m${i}`, `Closes #${it.number}`);
        const merged = await mergePull(app, alice, repo, pull, "squash");
        if (!merged.ok) throw new Error(String(merged.error));
      }
    }
  }, 120_000);

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  test("every word is the one tellWord gives, for every state", async () => {
    const issues = page();
    expect(issues.length).toBe(50);
    const closing = openPullsClosing(app.db, repo.id);
    const batched = await tellWords(ctx(), repo, issues, closing);
    for (const [i, issue] of issues.entries())
      expect(batched[i]).toEqual(await tellWord(ctx(), repo, issue, closing.get(issue.number)));
    const seen = new Set<string>(batched.map((w) => w?.word ?? "closed by hand"));
    for (const w of ["told", "working", "waiting", "stopped", "look", "planned", "shipped", "closed by hand"])
      expect(seen.has(w)).toBe(true);
  }, 60_000);

  test("the queries do not grow with the page: ten issues and fifty cost about the same", async () => {
    const all = page();
    const closing = openPullsClosing(app.db, repo.id);
    const real = app.db.query.bind(app.db);
    let count = 0;
    (app.db as { query: unknown }).query = (...args: Parameters<typeof real>) => {
      count++;
      return real(...args);
    };
    const queries = async (issues: Issue[]): Promise<number> => {
      count = 0;
      await tellWords(ctx(), repo, issues, closing);
      return count;
    };
    try {
      const ten = await queries(all.slice(0, 10));
      const fifty = await queries(all);
      expect(fifty).toBeLessThanOrEqual(30);
      expect(fifty).toBe(ten);
      // Without the batch, fifty tellWord calls each read on their own.
      count = 0;
      for (const issue of all) await tellWord(ctx(), repo, issue, closing.get(issue.number));
      expect(count).toBeGreaterThan(fifty * 3);
    } finally {
      (app.db as { query: unknown }).query = real;
    }
  });

  test("a page of fifty is worded in under 5 ms", async () => {
    const all = page();
    const closing = openPullsClosing(app.db, repo.id);
    await tellWords(ctx(), repo, all, closing);
    const laps: number[] = [];
    for (let n = 0; n < 25; n++) {
      const at = performance.now();
      await tellWords(ctx(), repo, all, closing);
      laps.push(performance.now() - at);
    }
    expect(Math.min(...laps)).toBeLessThan(5);
  });
});
