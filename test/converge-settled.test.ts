/**
 * A fork's "Take updates from <parent>" issue is only open while the
 * parent's tip is not yet in the fork. Once it is — merged by hand, by a
 * person, anywhere — the issue closes itself, naming both commits, and the
 * run queued for it is cancelled instead of started.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import {
  convergeFork,
  convergeIssue,
  settleAll,
} from "../src/crew/converge.ts";
import { getIssueById, listComments } from "../src/core/issues.ts";
import { forkRelation } from "../src/core/following.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { listRuns } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { resolveOid } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";
import { promote } from "./helpers/members.ts";

describe("a converge issue whose parent tip the fork already holds", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let bob: User;
  let parent: Repo;
  let fork: Repo;
  let issueId: string;

  const fresh = (r: Repo): Repo => getRepoById(app.db, r.id)!;
  const commit = (who: User, repo: Repo, path: string, content: string) =>
    commitToBranch(app, who, repo, {
      message: `${who.username}: ${path}`,
      files: [{ path, content }],
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-converge-settled-"));
    app = createApp({ dataDir, port: 0 });
    const a = await createUser(app.db, {
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    const b = await createUser(app.db, {
      trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!a.ok || !b.ok) throw new Error("users");
    alice = a.value;
    bob = b.value;
    promote(app.db, bob);
    const made = await createRepo(app, alice, { name: "game", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    parent = made.value;
    await commit(alice, parent, "README.md", "# game\n");
    const forked = await forkRepo(app, bob, parent);
    if (!forked.ok) throw new Error(String(forked.error));
    fork = forked.value;
    const bot = await createAgent(app, alice, { username: "bot", brief: "Be brief." });
    if (!bot.ok) throw new Error(String(bot.error));
    expect(addToCrew(app, bob, fresh(fork), "bot").ok).toBe(true);
    // Both sides change the same file: a decision, so the crew gets an issue.
    await commit(bob, fork, "README.md", "# game — by bob\n");
    await commit(alice, parent, "README.md", "# game — by alice\n");
    const out = await convergeFork(app, fresh(fork), fresh(parent), bob);
    expect(out.kind).toBe("queued");
    issueId = out.kind === "queued" ? out.issue.id : "";
  }, 30_000);

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const runsFor = () =>
    listRuns(app.db, fork.id, { kind: "agent", limit: 20 }).filter(
      (r) => r.issueId === issueId,
    );

  test("a fork still diverged keeps its issue open and its run queued", async () => {
    expect(await settleAll(app)).toBe(0);
    expect(getIssueById(app.db, issueId)?.state).toBe("open");
    expect(runsFor().map((r) => r.state)).toEqual(["queued"]);
  });

  test("merging the parent by hand closes the issue, names both commits, starts no run", async () => {
    const parentDir = repoDir(app.reposRoot, "alice", "game");
    const forkDir = repoDir(app.reposRoot, "bob", "game");
    const parentTip = (await resolveOid(parentDir, "refs/heads/main"))!;
    const forkTip = (await resolveOid(forkDir, "refs/heads/main"))!;
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "bob",
      GIT_AUTHOR_EMAIL: "bob@forge.local",
      GIT_COMMITTER_NAME: "bob",
      GIT_COMMITTER_EMAIL: "bob@forge.local",
    };
    const git = async (...args: string[]) => {
      const p = Bun.spawn(["git", ...args], { cwd: forkDir, env, stdout: "pipe", stderr: "pipe" });
      const out = await new Response(p.stdout).text();
      expect(await p.exited).toBe(0);
      return out.trim();
    };
    const merge = await git(
      "commit-tree", `${forkTip}^{tree}`, "-p", forkTip, "-p", parentTip, "-m", "merge alice by hand",
    );
    await git("update-ref", "refs/heads/main", merge);
    expect((await forkRelation(app, fresh(fork), fresh(parent)))?.state).toBe("ahead");

    expect(await settleAll(app)).toBe(1);
    const issue = getIssueById(app.db, issueId)!;
    expect(issue.state).toBe("closed");
    expect(convergeIssue(app, fresh(fork), fresh(parent))).toBeUndefined();
    const said = listComments(app.db, issueId).map((c) => c.body).join("\n");
    expect(said).toContain(parentTip.slice(0, 7));
    expect(said).toContain(merge.slice(0, 7));
    expect(runsFor().map((r) => r.state)).toEqual(["cancelled"]);
    // Nothing is left to do twice.
    expect(await settleAll(app)).toBe(0);
  });

  test("asking the crew to converge now opens nothing and queues nothing", async () => {
    const out = await convergeFork(app, fresh(fork), fresh(parent), bob);
    expect(out.kind).toBe("nothing");
    expect(runsFor().length).toBe(1);
  });
});
