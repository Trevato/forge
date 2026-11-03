/**
 * The crew loop with a stand-in Claude Code, second half: the pull that opens
 * at the first push, while the run is still going, and what the run's end
 * does to it. Split from `crew.test.ts` so each half stays under the slow-file
 * limit (#2314).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../src/app.ts";
import {
  addComment,
  assignIssue,
  editIssue,
  openIssue,
  setIssueState,
} from "../src/actions/issues.ts";
import { answeredBeforeStop } from "../src/crew/already.ts";
import { alreadyDone } from "../src/core/done_on_main.ts";
import { updateRepoSettings } from "../src/actions/repos.ts";
import { pullOfBranch, watchForPull } from "../src/crew/early.ts";
import { contentOnBase, resolveOid } from "../src/git/merge.ts";
import { openPull } from "../src/actions/pulls.ts";
import { readRepoFlow } from "../src/flow/repo_flow.ts";
import { abortAgentRun } from "../src/crew/running.ts";
import { getAgentByName } from "../src/core/agents.ts";
import { createIssue, getIssue, listComments } from "../src/core/issues.ts";
import { listPulls, mergePull } from "../src/core/pulls.ts";
import { repoDir } from "../src/git/repos.ts";
import { getForkOf, type Repo } from "../src/core/repos.ts";
import { getRun, listRuns, type Run } from "../src/core/runs.ts";
import type { User } from "../src/core/users.ts";
import { readRunLog } from "../src/runs/log.ts";
import {
  agentRunSettled,
  startStandInCrew,
  stopStandInCrew,
  type StandInCrew,
} from "./helpers/crew-standin.ts";

describe("the crew, with a stand-in Claude Code: the early pull", () => {
  let standIn: StandInCrew;
  let dataDir: string;
  let app: App;
  let alice: User;
  let bot: User;
  let repo: Repo;

  const settled = (where: (run: Run) => boolean, timeoutMs?: number) =>
    agentRunSettled(app, repo, where, timeoutMs);

  beforeAll(async () => {
    standIn = await startStandInCrew();
    ({ dataDir, app, alice, bot, repo } = standIn);
  }, 30_000);

  afterAll(() => stopStandInCrew(standIn));

  test("the pull opens at the first push, in progress, and the run's end fills that same pull in", async () => {
    const issue = openIssue(app, alice, repo, {
      title: "Plant crocuses",
      body: "LINGER-ME by the gate.",
    });
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;
    expect(assignIssue(app, alice, repo, issue.value, bot).ok).toBe(true);
    const branch = `bot/${issue.value.number}-plant-crocuses`;
    const mine = () =>
      listPulls(app.db, repo.id, { state: "open", limit: 200 }).filter(
        (p) => p.headBranch === branch,
      );
    // The agent has pushed and is still working: the pull is already there.
    const deadline = Date.now() + 20_000;
    while (mine().length === 0 && Date.now() < deadline) await Bun.sleep(100);
    if (mine().length === 0) throw new Error(`never came: still waiting while mine().length === 0`);
    const early = mine()[0]!;
    expect(early).toBeDefined();
    expect(early.title).toBe("Plant crocuses");
    expect(early.baseBranch).toBe(repo.defaultBranch);
    expect(early.body).toStartWith("In progress:");
    expect(early.body).toMatch(/\/runs\/[\w-]+/);
    expect(early.body).toContain(`Closes #${issue.value.number}`);
    expect(existsSync(join(dataDir, "release"))).toBe(false);

    writeFileSync(join(dataDir, "release"), "");
    const run = await settled((r) => r.branch === branch);
    expect(run.state).toBe("ok");
    expect(run.summary).toMatch(new RegExp(`^opened pull #${early.number}\\b`));
    const after = mine();
    expect(after.length).toBe(1);
    expect(after[0]!.number).toBe(early.number);
    expect(after[0]!.body).not.toContain("In progress:");
    expect(after[0]!.body).toContain("Added CREW.md as asked.");
    expect(after[0]!.body).toContain(`Closes #${issue.value.number}`);
    const log = readRunLog(dataDir, run.id).lines.join("\n");
    expect(log).toContain(`opened pull #${early.number} at the first push`);
  }, 60_000);

  test("a run whose branch is ahead by commits but level in content proposes nothing and opens no pull (#8628)", async () => {
    rmSync(join(dataDir, "release"), { force: true });
    const issue = openIssue(app, alice, repo, { title: "Plant lichen", body: "LEVEL-ME on the wall." });
    if (!issue.ok) throw new Error("issue");
    expect(assignIssue(app, alice, repo, issue.value, bot).ok).toBe(true);
    const branch = `bot/${issue.value.number}-plant-lichen`;
    const run = await settled((r) => r.branch === branch);
    expect(run.summary).not.toMatch(/opened pull|updated pull/);
    const fork = getForkOf(app.db, bot.id, repo.id)!;
    const forkBare = repoDir(app.reposRoot, fork.ownerName, fork.name);
    const bare = repoDir(app.reposRoot, repo.ownerName, repo.name);
    // The branch is ahead by a commit, yet holds nothing the base lacks.
    const head = (await resolveOid(forkBare, `refs/heads/${branch}`))!;
    const base = (await resolveOid(bare, `refs/heads/${repo.defaultBranch}`))!;
    expect(await contentOnBase(forkBare, base, head)).toBe(true);
    expect(pullOfBranch(app, repo, fork, branch)).toBeUndefined();
    expect(readRunLog(dataDir, run.id).lines.join("\n")).toContain("nothing to propose");
  }, 60_000);

  test("a body a person edited while the run was going is left alone at the run's end", async () => {
    rmSync(join(dataDir, "release"), { force: true });
    const issue = openIssue(app, alice, repo, {
      title: "Plant snowdrops",
      body: "LINGER-ME under the oak.",
    });
    if (!issue.ok) throw new Error("issue");
    expect(assignIssue(app, alice, repo, issue.value, bot).ok).toBe(true);
    const branch = `bot/${issue.value.number}-plant-snowdrops`;
    const mine = () =>
      listPulls(app.db, repo.id, { state: "open", limit: 200 }).filter(
        (p) => p.headBranch === branch,
      );
    const deadline = Date.now() + 20_000;
    while (mine().length === 0 && Date.now() < deadline) await Bun.sleep(100);
    if (mine().length === 0) throw new Error(`never came: still waiting while mine().length === 0`);
    const early = mine()[0]!;
    expect(
      editIssue(app, alice, repo, early, { body: "My own words.\n\nCloses #1" }).ok,
    ).toBe(true);
    writeFileSync(join(dataDir, "release"), "");
    const run = await settled((r) => r.branch === branch);
    expect(run.summary).toMatch(new RegExp(`^updated pull #${early.number}\\b`));
    expect(mine()[0]!.body).toBe("My own words.\n\nCloses #1");
  }, 60_000);

  /** An agent's issue and ask, assigned, with the pull its first push opens. */
  async function pullAfterPush(word: string, slug: string) {
    rmSync(join(dataDir, "release"), { force: true });
    const issue = openIssue(app, alice, repo, { title: `Weed ${slug}`, body: word });
    if (!issue.ok) throw new Error("issue");
    expect(assignIssue(app, alice, repo, issue.value, bot).ok).toBe(true);
    const branch = `bot/${issue.value.number}-weed-${slug}`;
    const mine = () =>
      listPulls(app.db, repo.id, { state: "all", limit: 200 }).filter(
        (p) => p.headBranch === branch,
      );
    const deadline = Date.now() + 20_000;
    while (mine().length === 0 && Date.now() < deadline) await Bun.sleep(100);
    expect(mine()[0]!.state).toBe("open");
    writeFileSync(join(dataDir, "release"), "");
    const run = await settled((r) => r.branch === branch);
    return { run, pull: mine()[0]! };
  }

  test("a run that declines after its pull opened early closes that pull with the reason", async () => {
    const { run, pull } = await pullAfterPush("PUSH-THEN-DECLINE", "declines");
    expect(pull.state).toBe("closed");
    expect(pull.body).not.toContain("In progress:");
    expect(pull.body).toContain("Declined: this turned out to be out of scope.");
    expect(pull.body).toContain(`/runs/${run.id}`);
  }, 60_000);

  test("a run that fails after its pull opened early has pushed work: the pull stays open for review", async () => {
    const { run, pull } = await pullAfterPush("PUSH-THEN-FAIL", "fails");
    expect(run.state).toBe("ok");
    expect(pull.state).toBe("open");
    expect(pull.body).not.toContain("In progress:");
  }, 60_000);

  test("an agent may close a pull it wrote and nothing else", () => {
    const make = (authorId: string, kind: "issue" | "pull") => {
      const made = createIssue(app.db, {
        repoId: repo.id,
        authorId,
        title: `Withdraw ${kind}`,
        kind,
      });
      if (!made.ok) throw new Error("issue");
      return made.value;
    };
    const own = make(bot.id, "pull");
    expect(setIssueState(app, bot, repo, own, "closed").ok).toBe(true);
    const theirs = make(alice.id, "pull");
    const refused = setIssueState(app, bot, repo, theirs, "closed");
    expect(refused.ok).toBe(false);
    expect(getIssue(app.db, repo.id, theirs.number)!.state).toBe("open");
    const ownIssue = make(bot.id, "issue");
    expect(setIssueState(app, bot, repo, ownIssue, "closed").ok).toBe(false);
    expect(getIssue(app.db, repo.id, ownIssue.number)!.state).toBe("open");
  });

  test("a pull a person commented on stays open when the run declines, with a comment", async () => {
    rmSync(join(dataDir, "release"), { force: true });
    const issue = openIssue(app, alice, repo, {
      title: "Weed PUSH-THEN-DECLINE twice",
      body: "PUSH-THEN-DECLINE",
    });
    if (!issue.ok) throw new Error("issue");
    expect(assignIssue(app, alice, repo, issue.value, bot).ok).toBe(true);
    const branch = `bot/${issue.value.number}-weed-push-then-decline-twice`;
    const mine = () =>
      listPulls(app.db, repo.id, { state: "all", limit: 200 }).filter(
        (p) => p.headBranch === branch,
      );
    const deadline = Date.now() + 20_000;
    while (mine().length === 0 && Date.now() < deadline) await Bun.sleep(100);
    if (mine().length === 0) throw new Error(`never came: still waiting while mine().length === 0`);
    const early = mine()[0]!;
    expect(addComment(app, alice, repo, early, "I like where this goes.").ok).toBe(true);
    writeFileSync(join(dataDir, "release"), "");
    await settled((r) => r.branch === branch);
    // The comment queued a follow-up run; let it end before the next test.
    const idle = Date.now() + 20_000;
    while (
      listRuns(app.db, repo.id, { kind: "agent" }).some(
        (r) => r.state === "queued" || r.state === "running",
      ) &&
      Date.now() < idle
    )
      await Bun.sleep(100);
    expect(mine()[0]!.state).toBe("open");
    const last = listComments(app.db, early.id).at(-1)!;
    expect(last.body).toContain("this turned out to be out of scope.");
    expect(last.body).toContain("Left open");
  }, 60_000);

  test("a run cancelled after its first push leaves the pull saying the run ended, with the log", async () => {
    // The stand-in waits for the release file; take it away so it lingers.
    rmSync(join(dataDir, "release"), { force: true });
    const issue = openIssue(app, alice, repo, {
      title: "Plant bluebells",
      body: "LINGER-ME in the shade.",
    });
    if (!issue.ok) throw new Error("issue");
    expect(assignIssue(app, alice, repo, issue.value, bot).ok).toBe(true);
    const branch = `bot/${issue.value.number}-plant-bluebells`;
    const mine = () =>
      listPulls(app.db, repo.id, { state: "open", limit: 200 }).filter(
        (p) => p.headBranch === branch,
      );
    const deadline = Date.now() + 20_000;
    while (mine().length === 0 && Date.now() < deadline) await Bun.sleep(100);
    expect(mine()[0]!.body).toStartWith("In progress:");
    const running = listRuns(app.db, repo.id, { kind: "agent" }).find(
      (r) => r.branch === branch,
    )!;
    expect(abortAgentRun(running.id)).toBe(true);
    const run = await settled((r) => r.branch === branch);
    expect(run.summary).toContain("cancelled");
    const body = mine()[0]!.body;
    expect(body).not.toContain("In progress:");
    expect(body).toStartWith("The run ended before it reported");
    expect(body).toContain(`/runs/${run.id}`);
    expect(body).toContain(`Closes #${issue.value.number}`);
  }, 60_000);

  test("an early open that fails is tried once and leaves no pull behind", async () => {
    const agent = getAgentByName(app.db, "bot")!;
    const fork = getForkOf(app.db, bot.id, repo.id)!;
    const bare = repoDir(app.reposRoot, repo.ownerName, repo.name);
    const forkBare = repoDir(app.reposRoot, fork.ownerName, fork.name);
    const issue = openIssue(app, alice, repo, { title: "Plant ferns", body: "Shade." });
    if (!issue.ok) throw new Error("issue");
    // A branch one commit beyond the base, in the fork.
    const branch = "bot/early-fails";
    const git = async (...args: string[]) => {
      const p = Bun.spawn(["git", ...args], {
        cwd: forkBare,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.test",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.test",
        },
      });
      const out = await new Response(p.stdout).text();
      expect(await p.exited).toBe(0);
      return out.trim();
    };
    const baseTip = (await resolveOid(bare, `refs/heads/${repo.defaultBranch}`))!;
    // The empty tree: content the base does not hold (#8628 stops a branch
    // whose content it does).
    const tree = await git("hash-object", "-t", "tree", "/dev/null");
    const commit = await git("commit-tree", tree, "-p", baseTip, "-m", "ferns");
    await git("update-ref", `refs/heads/${branch}`, commit);

    const lines: string[] = [];
    // An issue with no title is one the forge cannot open a pull for.
    const untitled = { ...issue.value, title: "" };
    const run = listRuns(app.db, repo.id, { kind: "agent" })[0]!;
    const early = watchForPull({
      app, repo, agent, issue: untitled, run, fork, branch, forkBare, bare,
      forgeUrl: "http://forge.test",
      write: (l) => lines.push(l),
      variantGroup: null,
      continuing: false,
      intervalMs: 20,
    });
    const deadline = Date.now() + 5_000;
    while (lines.length === 0 && Date.now() < deadline) await Bun.sleep(20);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("could not open the pull early");
    // Many looks later it has not tried again, and no pull stands.
    await Bun.sleep(300);
    await early.stop();
    expect(lines.length).toBe(1);
    expect(pullOfBranch(app, repo, fork, branch)).toBeUndefined();
  }, 30_000);

  test("a branch ahead by commits but level in content opens no pull, run after run, and a carried close is no landing (#8628)", async () => {
    const agent = getAgentByName(app.db, "bot")!;
    const fork = getForkOf(app.db, bot.id, repo.id)!;
    const bare = repoDir(app.reposRoot, repo.ownerName, repo.name);
    const forkBare = repoDir(app.reposRoot, fork.ownerName, fork.name);
    const issue = openIssue(app, alice, repo, { title: "Plant moss", body: "Damp." });
    if (!issue.ok) throw new Error("issue");
    const git = async (...args: string[]) => {
      const p = Bun.spawn(["git", ...args], {
        cwd: forkBare,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.test",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.test",
        },
      });
      const out = await new Response(p.stdout).text();
      expect(await p.exited).toBe(0);
      return out.trim();
    };
    // One commit beyond the base whose tree is the base's: its content is
    // already there, as after a squash landed it.
    const branch = "bot/already-carried";
    const baseTip = (await resolveOid(bare, `refs/heads/${repo.defaultBranch}`))!;
    const tree = await git("rev-parse", `${baseTip}^{tree}`);
    const commit = await git("commit-tree", tree, "-p", baseTip, "-m", "moss");
    await git("update-ref", `refs/heads/${branch}`, commit);
    expect(await contentOnBase(forkBare, baseTip, commit)).toBe(true);

    const run = listRuns(app.db, repo.id, { kind: "agent" })[0]!;
    for (let again = 0; again < 3; again++) {
      const lines: string[] = [];
      const early = watchForPull({
        app, repo, agent, issue: issue.value, run, fork, branch, forkBare, bare,
        forgeUrl: "http://forge.test",
        write: (l) => lines.push(l),
        variantGroup: null,
        continuing: false,
        intervalMs: 10,
      });
      await Bun.sleep(100);
      await early.stop();
      expect(lines).toEqual([]);
    }
    expect(pullOfBranch(app, repo, fork, branch)).toBeUndefined();

    // Opened anyway, a pull like it closes as merged, and landed counts none.
    const opened = await openPull(app, bot, repo, {
      title: "Plant moss",
      body: `Closes #${issue.value.number}`,
      baseBranch: repo.defaultBranch,
      headBranch: branch,
      headRepo: fork,
    });
    if (!opened.ok) throw new Error("pull");
    const landed = await mergePull(app.db, bare, opened.value, {
      strategy: "squash",
      message: "moss",
      actorId: alice.id,
      author: { name: "t", email: "t@example.test" },
    });
    expect(landed.ok && landed.value.carried).toBe(true);
    expect(readRepoFlow(app.db, repo.id).landed1h).toBe(0);
  }, 30_000);

  test("a run whose pull is closed under it, after it answered already done on main, notes and holds its issue", async () => {
    rmSync(join(dataDir, "answered"), { force: true });
    // The note and the hold are the autonomous crew's (`settleAgentRun`).
    const on = await updateRepoSettings(app, alice, repo, {
      autonomy: "autonomous",
      autonomyDirection: "Keep the garden small.",
      autonomyCeilingUsd: 100,
      autonomyBy: alice.id,
    });
    expect(on.ok).toBe(true);
    try {
      const issue = openIssue(app, alice, repo, {
        title: "Weed the cress",
        body: "PUSH-THEN-DONE-ON-MAIN",
      });
      if (!issue.ok) throw new Error("issue");
      expect(assignIssue(app, alice, repo, issue.value, bot).ok).toBe(true);
      const branch = `bot/${issue.value.number}-weed-the-cress`;
      const mine = () =>
        listPulls(app.db, repo.id, { state: "all", limit: 200 }).filter(
          (p) => p.headBranch === branch,
        );
      const until = async (ok: () => boolean) => {
        const end = Date.now() + 15_000;
        while (!ok() && Date.now() < end) await Bun.sleep(20);
        return ok();
      };
      // The stand-in has pushed and given its answer; its pull is open.
      expect(
        await until(() => existsSync(join(dataDir, "answered")) && mine().length > 0),
      ).toBe(true);
      const pull = getIssue(app.db, repo.id, mine()[0]!.number)!;
      expect(setIssueState(app, alice, repo, pull, "closed").ok).toBe(true);
      // Cancelled at once by the pull; the runner then answers for it.
      const id = (await settled((r) => r.branch === branch)).id;
      await until(() => getRun(app.db, id)!.state !== "cancelled");
      const run = getRun(app.db, id)!;
      expect(run.state).toBe("ok");
      expect(run.summary).toMatch(/^already done: [0-9a-f]{40}$/);
      const oid = run.summary.slice("already done: ".length);
      await until(() => alreadyDone(app.db, [issue.value.id]).has(issue.value.id));
      const notes = listComments(app.db, issue.value.id).map((c) => c.body);
      expect(notes.some((b) => b.startsWith("Parked by the crew"))).toBe(false);
      expect(alreadyDone(app.db, [issue.value.id]).get(issue.value.id)).toEqual([oid]);
      expect(getIssue(app.db, repo.id, issue.value.number)!.assigneeId).toBeNull();
    } finally {
      await updateRepoSettings(app, alice, repo, { autonomy: "off" });
    }
  }, 30_000);

  test("a run its meter stopped keeps no decline; a run only its pull stopped does", () => {
    const decline = "DECLINED: already done on main in 0e2eaaf4";
    expect(answeredBeforeStop(undefined, decline)).toBe(true);
    expect(answeredBeforeStop(undefined, "DECLINED: out of scope")).toBe(false);
    expect(answeredBeforeStop(undefined, "Added CREW.md as asked.")).toBe(false);
    expect(answeredBeforeStop("the model grant is spent", decline)).toBe(false);
  });
});
