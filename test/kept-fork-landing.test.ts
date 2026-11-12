import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { proveAll } from "./helpers/verified.ts";
import { promote } from "./helpers/members.ts";
import { mcpTool } from "./helpers/mcp.ts";
import { landingKind } from "../src/core/landing_kind.ts";
import { getRepo } from "../src/core/repos.ts";
import { getUserByName } from "../src/core/users.ts";
import { tokenFor } from "./helpers/tokens.ts";

const gitEnv = gitClientEnv({
  GIT_AUTHOR_NAME: "Jay Moran",
  GIT_AUTHOR_EMAIL: "jay@f.dev",
  GIT_COMMITTER_NAME: "Jay Moran",
  GIT_COMMITTER_EMAIL: "jay@f.dev",
});

describe("a kept fork lands as a true merge (#8935)", () => {
  let dataDir: string;
  let work: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice = "";
  let bob = "";

  async function git(args: string[], cwd: string): Promise<string> {
    const p = Bun.spawn(["git", ...args], { cwd, env: gitEnv, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
    return out.trim();
  }
  const call = (path: string, token: string, body?: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const authed = (user: string, token: string) =>
    `${base.replace("http://", `http://${user}:${token}@`)}`;

  async function signup(username: string): Promise<string> {
    await fetch(`${base}/signup`, {
      method: "POST",
      body: new URLSearchParams({ username, email: `${username}@f.dev`, password: "kept-fork-pass" }),
      redirect: "manual",
    });
    return tokenFor(app, username, "admin", "k");
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-kf-"));
    work = await mkdtemp(join(tmpdir(), "forge-kf-work-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    alice = await signup("alice");
    bob = await signup("bob");
    proveAll(app);
    promote(app.db);
    await call("/api/v1/repos", alice, { name: "app", visibility: "public" });
    await git(["clone", `${authed("alice", alice)}/alice/app.git`, "a"], work);
    await Bun.write(join(work, "a/one.txt"), "one\n");
    await git(["add", "."], join(work, "a"));
    await git(["commit", "-m", "seed"], join(work, "a"));
    await git(["push", "origin", "main"], join(work, "a"));
    await call("/api/v1/repos/alice/app/forks", bob, {});
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("squash is asked for, a merge commit lands, authors kept, and his next pull is a fast-forward", async () => {
    const b = join(work, "b");
    await git(["clone", `${authed("bob", bob)}/bob/app.git`, "b"], work);
    for (const n of ["x", "y"]) {
      await Bun.write(join(b, `${n}.txt`), `${n}\n`);
      await git(["add", "."], b);
      await git(["commit", "-m", `add ${n}`], b);
    }
    await git(["push", "origin", "main"], b);
    const opened = await call("/api/v1/repos/alice/app/pulls", bob, {
      title: "Jay's work",
      base: "main",
      head: "main",
      headRepo: "bob/app",
    });
    expect(opened.status).toBe(201);
    const { number } = (await opened.json()) as { number: number };

    // Alice's main moves meanwhile, so the landing is a real merge.
    const a = join(work, "a");
    await Bun.write(join(a, "two.txt"), "two\n");
    await git(["add", "."], a);
    await git(["commit", "-m", "alice moves on"], a);
    await git(["push", "origin", "main"], a);

    const merged = await call(`/api/v1/repos/alice/app/pulls/${number}/merge`, alice, {
      strategy: "squash",
    });
    expect(merged.status).toBe(200);

    await git(["pull", "--no-rebase", "origin", "main"], a);
    const parents = (await git(["log", "-1", "--format=%P"], a)).split(" ");
    expect(parents).toHaveLength(2);
    const authors = await git(["log", "--format=%an", "--no-merges", "-3"], a);
    expect(authors).toContain("Jay Moran");
    expect(await git(["log", "--format=%s", "--no-merges", "--author=Jay"], a)).toContain("add x");

    // His side: pulling main back is clean (here a fast-forward of the merged tip).
    await git(["fetch", `${authed("alice", alice)}/alice/app.git`, "main"], b);
    const out = await git(["merge", "FETCH_HEAD", "--no-edit"], b);
    expect(out).not.toContain("CONFLICT");
    expect(await git(["rev-parse", "HEAD"], b)).toBe(await git(["rev-parse", "HEAD"], a));

    // The author is thanked on the pull with what landed.
    const notes = app.db
      .query<{ body: string }, [number]>(
        "SELECT body FROM comment WHERE issue_id = (SELECT id FROM issue WHERE kind = 'pull' AND number = ?1)",
      )
      .all(number);
    expect(notes.map((n) => n.body).join("\n")).toContain("Thank you");
  });

  test("a pull inside the repository still squashes", async () => {
    await call("/api/v1/repos/alice/app/edits", alice, {
      newBranch: "topic",
      base: "main",
      message: "inside",
      files: [{ path: "in.txt", content: "in\n" }],
    });
    const opened = await call("/api/v1/repos/alice/app/pulls", alice, {
      title: "inside",
      base: "main",
      head: "topic",
    });
    const { number } = (await opened.json()) as { number: number };
    const merged = await call(`/api/v1/repos/alice/app/pulls/${number}/merge`, alice, {
      strategy: "squash",
    });
    expect(merged.status).toBe(200);
    const a = join(work, "a");
    await git(["pull", "--no-rebase", "origin", "main"], a);
    expect((await git(["log", "-1", "--format=%P"], a)).split(" ")).toHaveLength(1);
  });

  describe("what is not a kept fork still squashes", () => {
    const shape = (over: { crossRepo?: boolean; authorId?: string } = {}) => {
      const head = getRepo(app.db, "bob", "app")!;
      return {
        crossRepo: over.crossRepo ?? true,
        headRepoId: head.id,
        authorId: over.authorId ?? getUserByName(app.db, "bob")!.id,
      };
    };
    const asAgent = (name: string, on: 0 | 1) =>
      app.db.query("UPDATE user SET is_agent = ?1 WHERE username = ?2").run(on, name);

    test("a person's fork is a merge whatever is asked", () => {
      expect(landingKind(app.db, shape(), "squash")).toBe("merge");
    });
    test("an agent who authors the pull", () => {
      asAgent("bob", 1);
      try {
        expect(landingKind(app.db, shape(), "squash")).toBe("squash");
      } finally {
        asAgent("bob", 0);
      }
    });
    test("an agent who owns the head repository", () => {
      asAgent("bob", 1);
      try {
        const authorId = getUserByName(app.db, "alice")!.id;
        expect(landingKind(app.db, shape({ authorId }), "squash")).toBe("squash");
      } finally {
        asAgent("bob", 0);
      }
    });
    test("a pull inside one repository", () => {
      expect(landingKind(app.db, shape({ crossRepo: false }), "squash")).toBe("squash");
    });
  });

  test("the MCP door honours the rule too: squash asked, a merge commit lands", async () => {
    const b = join(work, "b");
    await git(["pull", "--no-rebase", "--no-edit", "origin", "main"], b);
    await Bun.write(join(b, "z.txt"), "z\n");
    await git(["add", "."], b);
    await git(["commit", "-m", "add z"], b);
    await git(["push", "origin", "main"], b);
    const opened = await call("/api/v1/repos/alice/app/pulls", bob, {
      title: "more",
      base: "main",
      head: "main",
      headRepo: "bob/app",
    });
    const { number } = (await opened.json()) as { number: number };
    const a = join(work, "a");
    await Bun.write(join(a, "three.txt"), "three\n");
    await git(["add", "."], a);
    await git(["commit", "-m", "alice again"], a);
    await git(["push", "origin", "main"], a);
    const landed = await mcpTool(base, alice, "merge", {
      repo: "alice/app",
      number,
      strategy: "squash",
      dryRun: false,
    });
    expect(landed.error).toBeUndefined();
    await git(["pull", "--no-rebase", "origin", "main"], a);
    expect((await git(["log", "-1", "--format=%P"], a)).split(" ")).toHaveLength(2);
  });
});
