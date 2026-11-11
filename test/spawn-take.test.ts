/**
 * Taking the parent's code (#2634): local bare repositories, no network.
 * The parent's code goes on `forge/take-updates` in one pull; main never
 * moves. A conflict opens one issue and no pull; `tell-me` touches nothing.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { listEvents } from "../src/core/events.ts";
import { listIssues, setIssueState } from "../src/core/issues.ts";
import { listPulls } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { runGit } from "../src/git/env.ts";
import { repoDir } from "../src/git/repos.ts";
import { putBranch } from "../src/spawn/take.ts";
import { checkUpstream, upstreamState, upstreamWords } from "../src/spawn/upstream.ts";
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

  const pulls = () => listPulls(app.db, repo.id, { state: "open" }).filter((p) => p.headBranch === "forge/take-updates");

  test("an untouched fork fast-forwards main within one check, and opens no pull", async () => {
    const s = await checkUpstream(app, { remote: parent });
    const tip = await git(parent, "rev-parse", "refs/heads/main");
    expect(s?.taken).toEqual({ kind: "forwarded", commits: 1 });
    expect(await main()).toBe(tip);
    expect(pulls()).toHaveLength(0);
    expect(s?.behind).toBe(0);
    expect(taken()).toHaveLength(1);
    expect(listEvents(app.db, { repoId: repo.id, kind: "push" }).some((e) => JSON.stringify(e.payload).includes(tip))).toBe(true);
    expect(upstreamWords(s, s!.checkedAt)).toContain("1 commit from your parent was taken in");
    await checkUpstream(app, { remote: parent });
    expect(taken()).toHaveLength(1); // nothing new: nothing said again
  });

  test("a fork with commits of its own gets a pull, never an automatic merge", async () => {
    await mine("own.txt", "own\n");
    await theirs("p1.txt", "1\n");
    const before = await main();
    const s = await checkUpstream(app, { remote: parent });
    expect(pulls()).toHaveLength(1);
    const p = pulls()[0]!;
    expect(p.title).toBe("Take updates from root/forge");
    expect(p.authorId).toBe(kid.id);
    expect(s?.taken).toEqual({ kind: "pull", number: p.number, commits: 1 });
    expect(await main()).toBe(before);
    expect(taken()).toHaveLength(2);
    expect(upstreamWords(s, s!.checkedAt)).toContain(`1 commit from your parent is in pull #${p.number}`);
  });

  test("a second fetch with one more commit updates the same pull", async () => {
    const before = await main();
    const first = pulls()[0]!;
    await theirs("p1b.txt", "1b\n");
    const s = await checkUpstream(app, { remote: parent });
    expect(pulls()).toHaveLength(1);
    expect(pulls()[0]!.number).toBe(first.number);
    expect(s?.taken).toEqual({ kind: "pull", number: first.number, commits: 2 });
    expect(await main()).toBe(before);
    expect(taken()).toHaveLength(3);
    const pushed = listEvents(app.db, { repoId: repo.id, kind: "pull.pushed" });
    expect(pushed).toHaveLength(1);
    expect(JSON.stringify(pushed[0]!.payload)).toContain(first.number.toString());
  });

  test("a clean merge goes on the branch, not on main", async () => {
    await mine("mine.txt", "mine\n");
    await theirs("p2.txt", "2\n");
    const before = await main();
    const s = await checkUpstream(app, { remote: parent });
    expect(s?.taken?.kind).toBe("pull");
    expect(pulls()).toHaveLength(1);
    expect(await main()).toBe(before);
    const tip = "refs/heads/forge/take-updates";
    expect((await git(child, "rev-list", "--parents", "-n1", tip)).split(" ")).toHaveLength(3);
    expect(await git(child, "show", `${tip}:p2.txt`)).toBe("2");
    expect(await git(child, "show", `${tip}:mine.txt`)).toBe("mine");
    const at = await git(child, "rev-parse", tip);
    await checkUpstream(app, { remote: parent });
    expect(await git(child, "rev-parse", tip)).toBe(at); // the same merge is not made twice
  });

  test("a pull closed unmerged with nothing new opens nothing; a moved parent opens a fresh one", async () => {
    const closed = pulls()[0]!;
    setIssueState(app.db, closed.id, "closed", "dropped");
    expect(pulls()).toHaveLength(0);
    const s = await checkUpstream(app, { remote: parent });
    expect(pulls()).toHaveLength(0);
    expect(s?.taken).toBeUndefined();
    await theirs("p3.txt", "3\n");
    const t = await checkUpstream(app, { remote: parent });
    expect(pulls()).toHaveLength(1);
    expect(pulls()[0]!.number).not.toBe(closed.number);
    expect(t?.taken).toMatchObject({ kind: "pull", number: pulls()[0]!.number });
  });

  test("a stored record from before pulls is dropped, not thrown on", async () => {
    await Bun.write(
      join(app.config.dataDir, "upstream.json"),
      JSON.stringify({ behind: 1, parentTip: "a".repeat(40), checkedAt: Date.now(), error: "", taken: { kind: "took", commits: 2, merged: false, to: "b".repeat(40) } }),
    );
    const s = await upstreamState(app);
    expect(s?.behind).toBe(1);
    expect(s?.taken).toBeUndefined();
  });

  test("a branch moved since it was read is not overwritten", async () => {
    const tip = await git(child, "rev-parse", "refs/heads/forge/take-updates");
    const other = await git(child, "rev-parse", "refs/heads/main");
    // Someone pushed `other` after `had` was read as `stale`.
    await git(child, "update-ref", "refs/heads/forge/take-updates", other, tip);
    expect(await putBranch(child, tip, tip)).toBe(false);
    expect(await git(child, "rev-parse", "refs/heads/forge/take-updates")).toBe(other);
    expect(await putBranch(child, tip, other)).toBe(true);
    expect(await putBranch(child, tip, undefined)).toBe(false); // it exists: not a creation
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
    expect(pulls()).toHaveLength(1); // the conflict opened no second pull
    const issues = listIssues(app.db, repo.id, { sealed: true }).filter((i) => i.title === "Take updates from root/forge");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.body).toContain("a.txt");
    expect(taken()).toHaveLength(5);
  });

  test("a severed fork gets nothing", async () => {
    await Bun.write(
      join(app.config.dataDir, "parent.json"),
      JSON.stringify({
        upstream: "https://parent.test",
        forgeCode: { repo: "kid/forge", upstream: "root/forge", mode: "take-updates", tip: "a".repeat(40), chain: [], severedAt: new Date().toISOString() },
      }),
    );
    await theirs("p9.txt", "9\n");
    const before = await main();
    expect(await checkUpstream(app, { remote: parent })).toBeUndefined();
    expect(await main()).toBe(before);
    expect(taken()).toHaveLength(5);
  });
});
