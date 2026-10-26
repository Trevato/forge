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
  settleConverge,
} from "../src/crew/converge.ts";
import { getIssueById, listComments } from "../src/core/issues.ts";
import { listEvents } from "../src/core/events.ts";
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
  let carol: User;
  let n = 0;

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
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    const b = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    const c = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "carol",
      email: "carol@forge.local",
      password: "a-good-passphrase",
    });
    if (!a.ok || !b.ok || !c.ok) throw new Error("users");
    alice = a.value;
    bob = b.value;
    carol = c.value;
    promote(app.db, bob);
    const bot = await createAgent(app, alice, { username: "bot", brief: "Be brief." });
    if (!bot.ok) throw new Error(String(bot.error));
  }, 30_000);

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** A parent and bob's fork that both changed README.md, with the crew's converge issue open and a run queued. */
  async function diverged() {
    const name = `game${++n}`;
    const made = await createRepo(app, alice, { name, visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const parent = made.value;
    await commit(alice, parent, "README.md", "# game\n");
    const forked = await forkRepo(app, bob, parent);
    if (!forked.ok) throw new Error(String(forked.error));
    const fork = forked.value;
    expect(addToCrew(app, bob, fresh(fork), "bot").ok).toBe(true);
    // Both sides change the same file: a decision, so the crew gets an issue.
    await commit(bob, fork, "README.md", "# game — by bob\n");
    await commit(alice, parent, "README.md", "# game — by alice\n");
    const out = await convergeFork(app, fresh(fork), fresh(parent), bob);
    expect(out.kind).toBe("queued");
    const issueId = out.kind === "queued" ? out.issue.id : "";
    // The issue was opened by alice, so a comment as bob is not the author's.
    app.db.query("UPDATE issue SET author_id = ?1 WHERE id = ?2").run(alice.id, issueId);
    const runs = () =>
      listRuns(app.db, fork.id, { kind: "agent", limit: 20 }).filter(
        (r) => r.issueId === issueId,
      );
    return { parent, fork, issueId, runs, name };
  }

  /** Merge the parent's tip into the fork's default branch by hand; returns both commits. */
  async function mergeByHand(name: string) {
    const parentDir = repoDir(app.reposRoot, "alice", name);
    const forkDir = repoDir(app.reposRoot, "bob", name);
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
    return { parentTip, merge };
  }

  const closedBy = (forkId: string) =>
    listEvents(app.db, { repoId: forkId, kind: "issue.closed" })[0];

  test("a fork still diverged keeps its issue open and its run queued", async () => {
    const { issueId, runs } = await diverged();
    expect(await settleAll(app)).toBe(0);
    expect(getIssueById(app.db, issueId)?.state).toBe("open");
    expect(runs().map((r) => r.state)).toEqual(["queued"]);
  });

  test("a writer moving the branch closes the issue as the writer, naming both commits, starting no run", async () => {
    const { parent, fork, issueId, runs, name } = await diverged();
    const { parentTip, merge } = await mergeByHand(name);
    expect((await forkRelation(app, fresh(fork), fresh(parent)))?.state).toBe("ahead");

    expect(await settleConverge(app, fresh(fork), fresh(parent), bob)).toBe(true);
    expect(getIssueById(app.db, issueId)?.state).toBe("closed");
    expect(convergeIssue(app, fresh(fork), fresh(parent))).toBeUndefined();
    const comments = listComments(app.db, issueId);
    expect(comments.map((c) => c.authorId)).toEqual([bob.id]);
    expect(comments[0]!.body).toContain(parentTip.slice(0, 7));
    expect(comments[0]!.body).toContain(merge.slice(0, 7));
    expect(closedBy(fork.id)?.actorId).toBe(bob.id);
    const said = listEvents(app.db, { repoId: fork.id, kind: "issue.commented" })[0];
    expect(said?.actorId).toBe(bob.id);
    expect(runs().map((r) => r.state)).toEqual(["cancelled"]);
    // Nothing is left to do twice.
    expect(await settleAll(app)).toBe(0);
  });

  test("someone who cannot write the fork moving the branch closes the issue and says nothing", async () => {
    const { parent, fork, issueId } = await diverged();
    await mergeByHand(`game${n}`);
    expect(await settleConverge(app, fresh(fork), fresh(parent), carol)).toBe(true);
    expect(getIssueById(app.db, issueId)?.state).toBe("closed");
    expect(listComments(app.db, issueId)).toEqual([]);
    expect(closedBy(fork.id)?.actorId).toBe(carol.id);
  });

  test("the tick, with nobody who moved the branch, closes the issue and writes no comment", async () => {
    const { fork, issueId, runs } = await diverged();
    await mergeByHand(`game${n}`);
    expect(await settleAll(app)).toBe(1);
    expect(getIssueById(app.db, issueId)?.state).toBe("closed");
    expect(listComments(app.db, issueId)).toEqual([]);
    expect(closedBy(fork.id)?.actorId).toBeNull();
    expect(runs().map((r) => r.state)).toEqual(["cancelled"]);
  });

  test("asking the crew to converge now opens nothing and queues nothing", async () => {
    const { parent, fork, issueId, runs } = await diverged();
    await mergeByHand(`game${n}`);
    expect(await settleAll(app)).toBe(1);
    const out = await convergeFork(app, fresh(fork), fresh(parent), bob);
    expect(out.kind).toBe("nothing");
    expect(runs().length).toBe(1);
    expect(getIssueById(app.db, issueId)?.state).toBe("closed");
  });
});
