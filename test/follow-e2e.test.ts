/**
 * Following across forges, end to end (#2659): the parent commits, the child
 * checks by hand, the tell-me card lists the commits, take-updates opens one
 * pull, the owner merges it through the merge action, and a conflicting
 * parent commit opens one issue and no pull. Local bare repositories, no
 * network, no timers.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergePull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { listAssignedTo, listIssues } from "../src/core/issues.ts";
import { listPulls } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { runGit } from "../src/git/env.ts";
import { repoDir } from "../src/git/repos.ts";
import { setChainMode } from "../src/spawn/chain.ts";
import { checkUpstream, upstreamWords } from "../src/spawn/upstream.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const git = async (cwd: string, ...args: string[]) => {
  const r = await runGit(["-c", "user.name=t", "-c", "user.email=t@x.invalid", ...args], { cwd });
  if (!r.ok) throw new Error(r.error.stderr);
  return r.value.trim();
};

describe("following across forges, end to end", () => {
  let dir = "";
  let app: App;
  let kid: User;
  let repo: Repo;
  let child = "";
  let parent = "";
  let work = "";

  const theirs = async (path: string, content: string, subject: string) => {
    await Bun.write(join(work, path), content);
    await git(work, "add", ".");
    await git(work, "commit", "-m", subject);
    await git(work, "push", "-q", parent, "HEAD:refs/heads/main");
  };
  const main = () => git(child, "rev-parse", "refs/heads/main");
  const takes = () => listPulls(app.db, repo.id, { state: "open" }).filter((p) => p.headBranch === "forge/take-updates");

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-follow-e2e-"));
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
    const base = await commitToBranch(app, kid, repo, { message: "base", files: [{ path: "a.txt", content: "base\n" }] });
    if (!base.ok) throw new Error(JSON.stringify(base.error));
    parent = join(dir, "parent.git");
    work = join(dir, "work");
    await git(dir, "clone", "-q", "--bare", child, parent);
    await git(dir, "clone", "-q", parent, work);
    await Bun.write(
      join(app.config.dataDir, "parent.json"),
      JSON.stringify({
        upstream: "https://parent.test",
        forgeCode: { repo: "kid/forge", upstream: "root/forge", mode: "tell-me", tip: "a".repeat(40), chain: [] },
      }),
    );
  }, 30_000);

  afterAll(async () => {
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("the whole path", async () => {
    // 1-2. Two parent commits: behind 2, one card listing both.
    await theirs("p1.txt", "1\n", "parent one");
    await theirs("p2.txt", "2\n", "parent two");
    const told = await checkUpstream(app, { remote: parent });
    expect(told?.behind).toBe(2);
    expect(told?.taken).toBeUndefined();
    const cards = listAssignedTo(app.db, kid.id).filter((i) => i.title === "Your parent forge has 2 new commits");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.body).toContain("parent one");
    expect(cards[0]!.body).toContain("parent two");
    expect(takes()).toHaveLength(0);

    // 3. take-updates, the fork having a commit of its own: the next check opens one pull listing both; main stays.
    const own = await commitToBranch(app, kid, repo, { message: "own", files: [{ path: "own.txt", content: "own\n" }] });
    expect(own.ok).toBe(true);
    const start = await main();
    expect((await setChainMode(app, "take-updates")).ok).toBe(true);
    const took = await checkUpstream(app, { remote: parent });
    expect(took?.taken).toMatchObject({ kind: "pull", commits: 2 });
    expect(takes()).toHaveLength(1);
    const pull = takes()[0]!;
    expect(pull.body).toContain("2 new commits from root/forge");
    expect(pull.body).toContain("parent one");
    expect(pull.body).toContain("parent two");
    expect(await main()).toBe(start);

    // 4. The owner merges it; the next check says up to date.
    const merged = await mergePull(app, kid, repo, pull, "merge");
    expect(merged.ok).toBe(true);
    expect(await main()).not.toBe(start);
    const after = await checkUpstream(app, { remote: parent });
    expect(after?.behind).toBe(0);
    expect(after?.taken).toBeUndefined();
    expect(upstreamWords(after, after!.checkedAt)).toContain("up to date");
    expect(takes()).toHaveLength(0);

    // 5. A conflicting parent commit: one issue, no pull, main untouched.
    const r = await commitToBranch(app, kid, repo, { message: "kid edits", files: [{ path: "a.txt", content: "kid's\n" }] });
    expect(r.ok).toBe(true);
    await theirs("a.txt", "parent's\n", "parent edits a");
    const before = await main();
    const clash = await checkUpstream(app, { remote: parent });
    expect(clash?.taken).toMatchObject({ kind: "conflict", files: ["a.txt"] });
    await checkUpstream(app, { remote: parent });
    expect(takes()).toHaveLength(0);
    expect(await main()).toBe(before);
    const issues = listIssues(app.db, repo.id, { sealed: true }).filter((i) => i.title === "Take updates from root/forge");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.body).toContain("a.txt");
  });
});
