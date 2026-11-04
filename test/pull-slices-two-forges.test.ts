/**
 * After a fork's pull lands in slices, the author's `git merge main` is
 * clean (#9043), proven with two forges: the author works on forge B, whose
 * repository is a fork of forge A's, and proposes to A through a fork there.
 * A lands the pull in two slices; the author's clone then merges A's main
 * with every one of their commits already an ancestor of it, and pushes the
 * result back to B without forcing.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { proveAll } from "./helpers/verified.ts";
import { promote } from "./helpers/members.ts";
import { tokenFor } from "./helpers/tokens.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const gitEnv = gitClientEnv({
  GIT_AUTHOR_NAME: "Jay Moran",
  GIT_AUTHOR_EMAIL: "jay@f.dev",
  GIT_COMMITTER_NAME: "Jay Moran",
  GIT_COMMITTER_EMAIL: "jay@f.dev",
});

async function run(args: string[], cwd: string): Promise<{ ok: boolean; out: string; err: string }> {
  const p = Bun.spawn(["git", ...args], { cwd, env: gitEnv, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { ok: code === 0, out: out.trim(), err };
}

async function git(args: string[], cwd: string): Promise<string> {
  const r = await run(args, cwd);
  if (!r.ok) throw new Error(`git ${args.join(" ")}: ${r.err}`);
  return r.out;
}

/**
 * The author's side, as the issue states it: every commit of theirs is an
 * ancestor of `main`, and `git merge main` in their clone is a fast-forward
 * or a clean merge. Answers why not, or "" when it holds.
 */
async function authorMergeIsClean(clone: string, main: string, mine: readonly string[]): Promise<string> {
  for (const oid of mine) {
    if (!(await run(["merge-base", "--is-ancestor", oid, main], clone)).ok)
      return `${oid.slice(0, 7)} is not an ancestor of main: a slice rewrote it`;
  }
  const merged = await run(["merge", "--no-edit", main], clone);
  if (!merged.ok) {
    await run(["merge", "--abort"], clone);
    return `git merge main did not finish: ${merged.err.trim()}`;
  }
  return "";
}

interface Forge {
  readonly app: App;
  readonly servers: Servers;
  readonly url: string;
}

describe("a fork's pull lands in slices, across two forges (#9043)", () => {
  let dir = "";
  let a: Forge;
  let b: Forge;
  const tokens = new Map<string, string>();

  const start = async (name: string): Promise<Forge> => {
    const app = createApp({ dataDir: join(dir, name), port: 0 });
    const servers = await serve(app);
    return { app, servers, url: servers.url };
  };
  const signup = async (f: Forge, username: string): Promise<string> => {
    await fetch(`${f.url}/signup`, {
      method: "POST",
      body: new URLSearchParams({ username, email: `${username}@f.dev`, password: "two-forge-slice-pass" }),
      redirect: "manual",
    });
    proveAll(f.app);
    promote(f.app.db);
    const token = tokenFor(f.app, username, "admin", "k");
    tokens.set(`${f.url} ${username}`, token);
    return token;
  };
  const call = (f: Forge, user: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${f.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${tokens.get(`${f.url} ${user}`)}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const remote = (f: Forge, user: string, path: string) =>
    `${f.url.replace("http://", `http://${user}:${tokens.get(`${f.url} ${user}`)}@`)}/${path}.git`;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-sl2-"));
    a = await start("a");
    b = await start("b");
    await signup(a, "alice");
    await signup(a, "bob");
    await signup(b, "bob");

    // Forge A: alice's repository, one commit.
    await call(a, "alice", "/api/v1/repos", { name: "app", visibility: "public" });
    await git(["clone", remote(a, "alice", "alice/app"), "alice"], dir);
    await Bun.write(join(dir, "alice/one.txt"), "one\n");
    await git(["add", "."], join(dir, "alice"));
    await git(["commit", "-m", "seed"], join(dir, "alice"));
    await git(["push", "origin", "main"], join(dir, "alice"));

    // Forge B: bob's repository is a fork of A's, the same history.
    await call(b, "bob", "/api/v1/repos", { name: "app", visibility: "public" });
    await git(["clone", remote(a, "bob", "alice/app"), "bob"], dir);
    const clone = join(dir, "bob");
    await git(["remote", "rename", "origin", "a"], clone);
    await git(["remote", "add", "origin", remote(b, "bob", "bob/app")], clone);
    await git(["push", "origin", "main"], clone);
    // And on A, the fork a pull comes from.
    expect((await call(a, "bob", "/api/v1/repos/alice/app/forks", {})).status).toBeLessThan(300);
    await git(["remote", "add", "fork", remote(a, "bob", "bob/app")], clone);
  });

  afterAll(async () => {
    for (const f of [a, b]) {
      f?.servers.stop();
      f?.app.close();
    }
    await rm(dir, { recursive: true, force: true });
  });

  test("two slices land the author's commits as they are, and their merge of main is clean", async () => {
    const clone = join(dir, "bob");
    const mine: string[] = [];
    for (const n of ["x", "y", "z"]) {
      await Bun.write(join(clone, `${n}.txt`), `${n}\n`);
      await git(["add", "."], clone);
      await git(["commit", "-m", `add ${n}`], clone);
      mine.push(await git(["rev-parse", "HEAD"], clone));
    }
    await git(["push", "origin", "main"], clone);
    await git(["push", "fork", "main:work"], clone);
    const opened = await call(a, "bob", "/api/v1/repos/alice/app/pulls", {
      title: "Work from forge B",
      base: "main",
      head: "work",
      headRepo: "bob/app",
    });
    expect(opened.status).toBe(201);
    const { number } = (await opened.json()) as { number: number };

    // A moves on meanwhile, so each slice is a true merge.
    const upstream = join(dir, "alice");
    await Bun.write(join(upstream, "two.txt"), "two\n");
    await git(["add", "."], upstream);
    await git(["commit", "-m", "alice moves on"], upstream);
    await git(["push", "origin", "main"], upstream);

    const slice = (upTo: string) =>
      call(a, "alice", `/api/v1/repos/alice/app/pulls/${number}/slices`, { upTo });
    const first = await slice(mine[1]!);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ last: false, left: 1 });
    const last = await slice(mine[2]!);
    expect(last.status).toBe(200);
    expect(await last.json()).toMatchObject({ last: true, left: 0 });

    // Each slice merged one of the author's commits as it was.
    await git(["pull", "--no-rebase", "origin", "main"], upstream);
    const merges = (await git(["log", "--first-parent", "--merges", "--format=%P", "main"], upstream))
      .split("\n")
      .map((line) => line.split(" ")[1]!);
    expect(merges.length).toBeGreaterThanOrEqual(2);
    expect(merges.at(-1)).toBe(mine[1]!);

    // The author has gone on locally too: the merge is a real one, and clean.
    await Bun.write(join(clone, "w.txt"), "w\n");
    await git(["add", "."], clone);
    await git(["commit", "-m", "add w"], clone);
    const before = await git(["rev-parse", "HEAD"], clone);
    await git(["fetch", "a", "main"], clone);
    expect(await authorMergeIsClean(clone, "a/main", mine)).toBe("");
    const parents = (await git(["log", "-1", "--format=%P"], clone)).split(" ");
    expect(parents).toEqual([before, await git(["rev-parse", "a/main"], clone)]);
    // Nothing of A's main is a rewrite of the author's: no second copy of z's change.
    expect(await git(["log", "--format=%H", "-S", "z", "--", "z.txt"], clone)).toBe(mine[2]!);

    // And forge B's fork takes the result without a force.
    await git(["push", "origin", "main"], clone);
    expect(await git(["ls-remote", "origin", "main"], clone)).toStartWith(await git(["rev-parse", "HEAD"], clone));
  });

  test("the check fails when a slice is squashed or rebased in place of merged", async () => {
    const clone = join(dir, "bob");
    for (const n of ["p", "q"]) {
      await Bun.write(join(clone, `${n}.txt`), `${n}\n`);
      await git(["add", "."], clone);
      await git(["commit", "-m", `add ${n}`], clone);
    }
    const mine = [await git(["rev-parse", "HEAD~1"], clone), await git(["rev-parse", "HEAD"], clone)];
    const upstream = join(dir, "alice");

    // A squash: the author's two commits as one new commit on main.
    await git(["checkout", "-b", "squashed", "main"], upstream);
    await git(["fetch", join(dir, "bob"), "main"], upstream);
    await git(["merge", "--squash", "FETCH_HEAD"], upstream);
    await git(["commit", "-m", "squash"], upstream);
    await git(["fetch", upstream, "squashed:refs/remotes/rewritten/squashed"], clone);
    expect(await authorMergeIsClean(clone, "rewritten/squashed", mine)).toContain("not an ancestor");

    // A rebase: the same commits, copied onto main with new ids.
    await git(["checkout", "-b", "rebased", "main"], upstream);
    await git(["cherry-pick", ...mine], upstream);
    await git(["fetch", upstream, "rebased:refs/remotes/rewritten/rebased"], clone);
    expect(await authorMergeIsClean(clone, "rewritten/rebased", mine)).toContain("not an ancestor");
    await git(["checkout", "main"], upstream);
  });
});
