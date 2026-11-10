/**
 * What a park reason says about each try (#6873): the files each red head
 * changed since the head before it, the first since the base. Runs are
 * written with explicit instants; the wall clock is never read.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { trackPullHead, type Pull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { resolveOid } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";
import { openIssue } from "../src/actions/issues.ts";
import { listComments } from "../src/core/issues.ts";
import { parkPullTold } from "../src/crew/park_pull.ts";
import { triesChanged } from "../src/crew/tries.ts";

const at = (n: number) => `2026-01-01T00:00:${String(n).padStart(2, "0")}.000Z`;
const EPOCH = at(0);

describe("triesChanged", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let repo: Repo;
  let indexN = 0;
  let branchN = 0;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tries-"));
    app = createApp({ dataDir, port: 0 });
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createRepo(app, alice, { name: "engine", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, fresh(), {
      message: "Start",
      files: [{ path: "README.md", content: "start\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const fresh = () => getRepoById(app.db, repo.id)!;

  /** A pull whose branch holds one commit, so a pull exists to ask about. */
  async function newPull(): Promise<{ pull: Pull; branch: string }> {
    const branch = `feature/${++branchN}`;
    const c = await commitToBranch(app, alice, fresh(), {
      branch,
      base: "main",
      message: "First",
      files: [{ path: `first-${branchN}.txt`, content: "1\n" }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    const opened = await openPull(app, alice, fresh(), {
      title: "Tries",
      body: "",
      baseBranch: "main",
      headBranch: branch,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    return { pull: opened.value, branch };
  }

  /** Commit on the branch; the new head's oid. */
  async function commit(branch: string, files: { path: string; content: string }[]) {
    const c = await commitToBranch(app, alice, fresh(), { branch, message: "Try", files });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    return c.value.commitOid;
  }

  /** A finished check run on `oid`, created at second `n`. */
  function run(p: Pull, oid: string, state: "ok" | "failed", n: number, kind: "check" | "deploy" = "check") {
    const r = createRun(app.db, { repoId: repo.id, kind, issueId: p.id, commitOid: oid });
    claimRun(app.db, r.id);
    finishRun(app.db, r.id, { state, summary: state });
    app.db.query("UPDATE run SET created_at = ?2 WHERE id = ?1").run(r.id, at(n));
    return r;
  }

  /**
   * A commit adding one file whose name the API refuses (a newline), made
   * with git directly on top of the branch tip, the way a push could.
   */
  async function pushed(branch: string, path: string): Promise<string> {
    const bare = repoDir(app.reposRoot, repo.ownerName, repo.name);
    const index = join(dataDir, `index-${++indexN}`);
    const git = async (args: string[], stdin?: string) => {
      const proc = Bun.spawn(["git", ...args], {
        cwd: bare,
        stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          GIT_INDEX_FILE: index,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.test",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.test",
        },
      });
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      return out.trim();
    };
    const tip = (await resolveOid(bare, `refs/heads/${branch}`))!;
    await git(["read-tree", tip]);
    const blob = await git(["hash-object", "-w", "--stdin"], "x\n");
    await git(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`]);
    const tree = await git(["write-tree"]);
    const oid = await git(["commit-tree", tree, "-p", tip, "-m", "Odd"]);
    await git(["update-ref", `refs/heads/${branch}`, oid]);
    trackPullHead(app.db, repo.id, branch, oid);
    return oid;
  }

  test("tells each red head's files since the head before it, the first since the base", async () => {
    const { pull: p, branch } = await newPull();
    const h1 = await commit(branch, [{ path: "src/a.ts", content: "a\n" }]);
    const h2 = await commit(branch, [{ path: "src/b.ts", content: "b\n" }]);
    const h3 = await commit(branch, [{ path: "src/a.ts", content: "a2\n" }, { path: "src/c.ts", content: "c\n" }]);
    run(p, h1, "failed", 1);
    run(p, h2, "failed", 2, "deploy");
    run(p, h3, "failed", 3);
    const all = await triesChanged(app, fresh(), p, EPOCH);
    expect(all).toEqual(["try 1: first-" + branchN + ".txt, src/a.ts", "try 2: src/b.ts", "try 3: src/a.ts, src/c.ts"]);

    // With one try the first line says the files since the base.
    const { pull: q, branch: qb } = await newPull();
    const g1 = await commit(qb, [{ path: "src/x.ts", content: "x\n" }]);
    run(q, g1, "failed", 1);
    expect(await triesChanged(app, fresh(), q, EPOCH)).toEqual([
      `try 1: first-${branchN}.txt, src/x.ts`,
    ]);
  });

  test("skips a green run, a run before since, a repeated head and a non-oid head", async () => {
    const { pull: p, branch } = await newPull();
    const old = await commit(branch, [{ path: "old.ts", content: "o\n" }]);
    const green = await commit(branch, [{ path: "green.ts", content: "g\n" }]);
    const red = await commit(branch, [{ path: "red.ts", content: "r\n" }]);
    run(p, old, "failed", 1);
    run(p, green, "ok", 5);
    run(p, red, "failed", 6);
    run(p, red, "failed", 7);
    run(p, "not-an-oid", "failed", 8);
    run(p, "", "failed", 9);
    expect(await triesChanged(app, fresh(), p, at(2))).toEqual(["try 1: green.ts, red.ts"]);
    expect(await triesChanged(app, fresh(), p, at(9))).toEqual([]);
  });

  test("a head that changed nothing says so", async () => {
    const { pull: p, branch } = await newPull();
    const h1 = await commit(branch, [{ path: "same.ts", content: "s\n" }]);
    // The same tree again: a new commit with no file changed.
    const h2 = await commit(branch, [{ path: "same.ts", content: "s\n" }]);
    expect(h2).not.toBe(h1);
    run(p, h1, "failed", 1);
    run(p, h2, "failed", 2);
    expect(await triesChanged(app, fresh(), p, EPOCH)).toEqual([
      `try 1: first-${branchN}.txt, same.ts`,
      "try 2: no files changed",
    ]);
  });

  test("more files than the limit end in a count; a long line is cut with an ellipsis", async () => {
    const { pull: p, branch } = await newPull();
    const many = await commit(
      branch,
      ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"].map((n) => ({ path: `m/${n}.ts`, content: `${n}\n` })),
    );
    run(p, many, "failed", 1);
    expect(await triesChanged(app, fresh(), p, EPOCH)).toEqual([
      `try 1: first-${branchN}.txt, m/a.ts, m/b.ts, m/c.ts, m/d.ts, m/e.ts, m/f.ts, m/g.ts, m/h.ts, m/i.ts (+2 more)`,
    ]);

    const long = "d".repeat(100);
    const wide = await commit(branch, [
      { path: `${long}/one.ts`, content: "1\n" },
      { path: `${long}/two.ts`, content: "2\n" },
    ]);
    run(p, wide, "failed", 2);
    const lines = await triesChanged(app, fresh(), p, EPOCH);
    const cut = lines[1]!;
    expect(cut.length).toBe(160);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.startsWith(`try 2: ${long}/one.ts, `)).toBe(true);
  });

  test("a name with a newline or markup comes back as git gave it, as text", async () => {
    const { pull: p, branch } = await newPull();
    const odd = "we\nird/<img src=x onerror=alert(1)>.ts";
    const h = await pushed(branch, odd);
    run(p, h, "failed", 1);
    const lines = await triesChanged(app, fresh(), p, EPOCH);
    expect(lines).toEqual([`try 1: first-${branchN}.txt, ${odd}`]);
    expect(lines[0]).toContain("<img src=x onerror=alert(1)>");
    expect(lines[0]).not.toContain("&lt;");
  });

  test("a park note on the issue tells each failed try's files when the pull went red twice", async () => {
    app.db
      .query("UPDATE repo SET autonomy = 'autonomous', autonomy_by = ?2 WHERE id = ?1")
      .run(repo.id, alice.id);
    const issue = openIssue(app, alice, fresh(), { title: "Do it" });
    if (!issue.ok) throw new Error(String(issue.error));
    const branch = `feature/park-${++branchN}`;
    const c = await commitToBranch(app, alice, fresh(), {
      branch,
      base: "main",
      message: "First",
      files: [{ path: "first.txt", content: "1\n" }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    const opened = await openPull(app, alice, fresh(), {
      title: "Park",
      body: `Closes #${issue.value.number}`,
      baseBranch: "main",
      headBranch: branch,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const p = opened.value;
    const h1 = await commit(branch, [{ path: "src/a.ts", content: "a\n" }]);
    const h2 = await commit(branch, [{ path: "src/b.ts", content: "b\n" }]);
    run(p, h1, "failed", 1);
    run(p, h2, "failed", 2);
    // An agent's pull, so the crew may park it.
    expect(await parkPullTold(app, fresh(), { ...p, authorIsAgent: true }, "the check stayed red", "")).toBe(true);
    const note = listComments(app.db, issue.value.id).at(-1)!.body;
    expect(note).toContain("try 1: first.txt, src/a.ts");
    expect(note).toContain("try 2: src/b.ts");
  });

  test("tries from before the last human word are left out of the note", async () => {
    app.db
      .query("UPDATE repo SET autonomy = 'autonomous', autonomy_by = ?2 WHERE id = ?1")
      .run(repo.id, alice.id);
    const issue = openIssue(app, alice, fresh(), { title: "Again" });
    if (!issue.ok) throw new Error(String(issue.error));
    const branch = `feature/since-${++branchN}`;
    const c = await commitToBranch(app, alice, fresh(), {
      branch, base: "main", message: "First", files: [{ path: "first.txt", content: "1\n" }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    const opened = await openPull(app, alice, fresh(), {
      title: "Since", body: `Closes #${issue.value.number}`, baseBranch: "main", headBranch: branch,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const p = opened.value;
    const old = await commit(branch, [{ path: "src/old.ts", content: "o\n" }]);
    const h1 = await commit(branch, [{ path: "src/new1.ts", content: "a\n" }]);
    const h2 = await commit(branch, [{ path: "src/new2.ts", content: "b\n" }]);
    run(p, old, "failed", 1);
    run(p, h1, "failed", 20);
    run(p, h2, "failed", 21);
    const told = await parkPullTold(app, fresh(), { ...p, authorIsAgent: true }, "red", at(10));
    expect(told).toBe(true);
    const note = listComments(app.db, issue.value.id).at(-1)!.body;
    expect(note).toContain("src/new1.ts");
    expect(note).toContain("src/new2.ts");
    expect(note).not.toContain("src/old.ts");
  });

  test("two parks racing write one note", async () => {
    app.db
      .query("UPDATE repo SET autonomy = 'autonomous', autonomy_by = ?2 WHERE id = ?1")
      .run(repo.id, alice.id);
    const issue = openIssue(app, alice, fresh(), { title: "Race" });
    if (!issue.ok) throw new Error(String(issue.error));
    const branch = `feature/race-${++branchN}`;
    const c = await commitToBranch(app, alice, fresh(), {
      branch, base: "main", message: "First", files: [{ path: "first.txt", content: "1\n" }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    const opened = await openPull(app, alice, fresh(), {
      title: "Race", body: `Closes #${issue.value.number}`, baseBranch: "main", headBranch: branch,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const p = { ...opened.value, authorIsAgent: true };
    const h1 = await commit(branch, [{ path: "src/a.ts", content: "a\n" }]);
    const h2 = await commit(branch, [{ path: "src/b.ts", content: "b\n" }]);
    run(p, h1, "failed", 1);
    run(p, h2, "failed", 2);
    const results = await Promise.all([
      parkPullTold(app, fresh(), p, "red", ""),
      parkPullTold(app, fresh(), p, "red", ""),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const notes = listComments(app.db, issue.value.id).filter((x) => x.body.includes("try 1:"));
    expect(notes).toHaveLength(1);
  });
});
