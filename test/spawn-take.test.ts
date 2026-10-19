/**
 * Taking the parent's code (#2634): local bare repositories, no network.
 * A fast-forward and a clean merge move main and say so; a conflict leaves
 * main alone and opens one issue; `tell-me` never touches main.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { listEvents } from "../src/core/events.ts";
import { listIssues } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { runGit } from "../src/git/env.ts";
import { repoDir } from "../src/git/repos.ts";
import { checkUpstream, upstreamWords } from "../src/spawn/upstream.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const git = async (cwd: string, ...args: string[]) => {
  const r = await runGit(["-c", "user.name=t", "-c", "user.email=t@x.invalid", ...args], { cwd });
  if (!r.ok) throw new Error(r.error.stderr);
  return r.value.trim();
};

describe("taking the parent's code", () => {
  let dir = "";
  let app: App;
  let kid: User;
  let repo: Repo;
  let child = "";
  let parent = "";
  let work = "";

  const setMode = (mode: string) =>
    Bun.write(
      join(app.config.dataDir, "parent.json"),
      JSON.stringify({
        upstream: "https://parent.test",
        forgeCode: { repo: "kid/forge", upstream: "root/forge", mode, tip: "a".repeat(40), chain: [] },
      }),
    );
  const mine = async (path: string, content: string) => {
    const r = await commitToBranch(app, kid, repo, { message: `kid: ${path}`, files: [{ path, content }] });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
  };
  const theirs = async (path: string, content: string) => {
    await Bun.write(join(work, path), content);
    await git(work, "add", ".");
    await git(work, "commit", "-m", `parent: ${path}`);
    await git(work, "push", "-q", parent, "HEAD:refs/heads/main");
  };
  const main = () => git(child, "rev-parse", "refs/heads/main");
  const taken = () => listEvents(app.db, { repoId: repo.id, kind: "forge.updates_taken" });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-take-"));
    app = createApp({ dataDir: join(dir, "data"), url: "https://child.test", port: 0 });
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "kid",
      email: "kid@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
    kid = u.value;
    const made = await createRepo(app, kid, { name: "forge", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    child = repoDir(app.reposRoot, "kid", "forge");
    await mine("a.txt", "base\n");
    parent = join(dir, "parent.git");
    work = join(dir, "work");
    await git(dir, "clone", "-q", "--bare", child, parent);
    await git(dir, "clone", "-q", parent, work);
    await setMode("take-updates");
  }, 30_000);
  afterAll(async () => {
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("tell-me fetches and changes nothing on main", async () => {
    await setMode("tell-me");
    const before = await main();
    await theirs("p0.txt", "0\n");
    const s = await checkUpstream(app, { remote: parent });
    expect(s?.behind).toBe(1);
    expect(s?.taken).toBeUndefined();
    expect(await main()).toBe(before);
    await setMode("take-updates");
  });

  test("a fast-forward is taken and recorded", async () => {
    const s = await checkUpstream(app, { remote: parent });
    expect(s?.taken).toMatchObject({ kind: "took", commits: 1, merged: false });
    expect(s?.behind).toBe(0);
    expect(await main()).toBe(await git(parent, "rev-parse", "refs/heads/main"));
    expect(taken()).toHaveLength(1);
    expect(upstreamWords(s, s!.checkedAt)).toContain("took 1 new commit from your parent");
  });

  test("a clean merge makes a merge commit", async () => {
    await mine("mine.txt", "mine\n");
    await theirs("p1.txt", "1\n");
    const before = await main();
    const s = await checkUpstream(app, { remote: parent });
    expect(s?.taken).toMatchObject({ kind: "took", commits: 1, merged: true });
    expect(await main()).not.toBe(before);
    expect((await git(child, "rev-list", "--parents", "-n1", "refs/heads/main")).split(" ")).toHaveLength(3);
    expect(await git(child, "show", "refs/heads/main:p1.txt")).toBe("1");
    expect(await git(child, "show", "refs/heads/main:mine.txt")).toBe("mine");
    expect(taken()).toHaveLength(2);
  });

  test("a conflict changes nothing and opens one issue", async () => {
    await mine("a.txt", "kid's\n");
    await theirs("a.txt", "parent's\n");
    const before = await main();
    const s = await checkUpstream(app, { remote: parent });
    expect(s?.taken).toMatchObject({ kind: "conflict", files: ["a.txt"] });
    expect(await main()).toBe(before);
    await checkUpstream(app, { remote: parent });
    expect(await main()).toBe(before);
    const issues = listIssues(app.db, repo.id, { sealed: true }).filter((i) => i.title === "Take updates from root/forge");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.body).toContain("a.txt");
    expect(taken()).toHaveLength(2);
  });

});
