/**
 * The crew loop with a stand-in for Claude Code (`helpers/crew-standin.ts`):
 * one pull's life — assigned, cloned, worked, landed, fed back on, closed.
 * The rest of the loop is in the other `crew-*.test.ts` files, each on a
 * forge of its own so they run apart and in parallel (#1798).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "../src/app.ts";
import {
  addComment,
  assignIssue,
  editIssue,
  openIssue,
  setIssueState,
} from "../src/actions/issues.ts";
import { pullOfBranch, trailerFor, watchForPull } from "../src/crew/early.ts";
import { openPull } from "../src/actions/pulls.ts";
import { sandboxAvailable } from "../src/crew/sandbox.ts";
import { queueAgentRun, type CrewHandle } from "../src/crew/dispatch.ts";
import { abortAgentRun } from "../src/crew/running.ts";
import { workdirFor } from "../src/crew/runner.ts";
import { getAgentByName } from "../src/core/agents.ts";
import { createIssue, getIssue, listComments } from "../src/core/issues.ts";
import { listPulls } from "../src/core/pulls.ts";
import { resolveOid } from "../src/git/merge.ts";
import { listPaths } from "../src/git/read.ts";
import { repoDir } from "../src/git/repos.ts";
import { getForkOf, type Repo } from "../src/core/repos.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import type { User } from "../src/core/users.ts";
import type { Servers } from "../src/http/server.ts";
import { readRunLog } from "../src/runs/log.ts";
import { spellings, stripForgeDirs } from "../src/runs/paths.ts";
import {
  agentRunSettled,
  startStandInCrew,
  stopStandInCrew,
  type StandInCrew,
} from "./helpers/crew-standin.ts";

describe("stripForgeDirs", () => {
  test("strips a known directory, leaves the rest of the path", () => {
    expect(
      stripForgeDirs(["/data/crew/bot/1/2"], "/data/crew/bot/1/2/src/a.ts"),
    ).toBe("src/a.ts");
  });

  test("a line with no match passes through whole", () => {
    expect(stripForgeDirs(["/data/crew/bot/1/2"], "/usr/bin/ssh")).toBe(
      "/usr/bin/ssh",
    );
  });

  test("an empty directory is dropped, not used as a prefix", () => {
    expect(stripForgeDirs([""], "/usr/bin/ssh")).toBe("/usr/bin/ssh");
  });

  test("the directory alone reads as here, wherever it stands in the line", () => {
    const dir = "/data/crew/bot/1/2";
    expect(stripForgeDirs([dir], `cd ${dir} && ls ${dir}/src`)).toBe(
      "cd . && ls src",
    );
    expect(stripForgeDirs([dir], `at "${dir}/a.ts":3 (${dir})`)).toBe(
      'at "a.ts":3 (.)',
    );
  });

  test("its text inside a longer path is left whole, never a path that was not there", () => {
    const dir = "/var/folders/x/work";
    // The same directory through a symlink the forge did not resolve.
    expect(stripForgeDirs([dir], `/private${dir}/CREW.md`)).toBe(
      `/private${dir}/CREW.md`,
    );
    // A sibling whose name begins the same way.
    expect(stripForgeDirs(["/data/1/2"], "/data/1/23/a.ts /data/1/2.bak")).toBe(
      "/data/1/23/a.ts /data/1/2.bak",
    );
    // And the whole one beside them still goes.
    expect(
      stripForgeDirs(["/data/1/2"], "/data/1/23/a.ts /data/1/2/a.ts"),
    ).toBe("/data/1/23/a.ts a.ts");
  });

  test("a directory before a full stop that punctuates goes, and the stop stays", () => {
    const dir = "/var/folders/x/work";
    expect(stripForgeDirs([dir], `wrote to ${dir}.`)).toBe("wrote to .");
    expect(stripForgeDirs([dir], `${dir}. Then ${dir}/a.ts`)).toBe(
      ". Then a.ts",
    );
    // Inside brackets or quotes, before a comma, and in an ellipsis.
    expect(stripForgeDirs([dir], `(see ${dir}.)`)).toBe("(see .)");
    expect(stripForgeDirs([dir], `"${dir}.", it said`)).toBe('".", it said');
    expect(stripForgeDirs([dir], `${dir}...`)).toBe("...");
    // A name that goes on after the dot is a sibling, left whole — after
    // one dot or two.
    expect(stripForgeDirs([dir], `${dir}.bak is kept`)).toBe(
      `${dir}.bak is kept`,
    );
    expect(stripForgeDirs([dir], `${dir}..bak is kept`)).toBe(
      `${dir}..bak is kept`,
    );
  });

  test("a directory reached through a symlink reads relative under either spelling", async () => {
    const root = realpathSync(await mkdtemp(join(tmpdir(), "forge-paths-")));
    try {
      const real = join(root, "real");
      const link = join(root, "link");
      mkdirSync(real);
      symlinkSync(real, link);
      // The forge named the link; a child process reports the real path.
      const dirs = spellings([link]);
      expect(dirs).toEqual([link, real].sort((a, b) => b.length - a.length));
      expect(stripForgeDirs(dirs, `${real}/CREW.md`)).toBe("CREW.md");
      expect(stripForgeDirs(dirs, `${link}/CREW.md`)).toBe("CREW.md");
      // A directory that is not there yet keeps its own spelling.
      expect(spellings([join(root, "later"), ""])).toEqual([
        join(root, "later"),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("the crew, with a stand-in Claude Code", () => {
  let standIn: StandInCrew;
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let crew: CrewHandle;
  let alice: User;
  let bot: User;
  let repo: Repo;
  let argsFile: string;
  let promptFile: string;

  const settled = (where: (run: Run) => boolean, timeoutMs?: number) =>
    agentRunSettled(app, repo, where, timeoutMs);

  beforeAll(async () => {
    standIn = await startStandInCrew();
    ({ dataDir,app,servers,crew,alice,bot,repo,argsFile,promptFile } = standIn);
  }, 30_000);

  afterAll(() => stopStandInCrew(standIn));

  test("the stand-in is detected", () => {
    expect(crew.ready).toBe(true);
    expect(crew.detail).toContain("2.1.0");
  });

  let issueNumber = 0;

  test("assignment: clone, branch, brief, work, and the forge opens the pull", async () => {
    const issue = openIssue(app, alice, repo, {
      title: "Plant tulips",
      body: "Along the fence.",
    });
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;
    issueNumber = issue.value.number;
    expect(assignIssue(app, alice, repo, issue.value, bot).ok).toBe(true);

    const run = await settled((r) => r.reason === "assigned");
    expect(run.state).toBe("ok");
    expect(run.summary).toMatch(/^opened pull #\d+/);
    expect(run.sessionId).toBe("fake-1");
    expect(run.costUsd).toBeCloseTo(0.01);
    expect(run.branch).toBe("bot/1-plant-tulips");

    const args = readFileSync(argsFile, "utf8");
    expect(args).toContain("--append-system-prompt");
    expect(args).toContain("--restricted");
    // Half of the $1 budget; the other half is held back for the wrap-up.
    expect(args).toContain("--max-budget-usd\n0.50");
    expect(args).not.toContain("--resume");
    // The sandbox policy: the forge reachable, the forge's data not readable,
    // the agent's own clone not among the denials.
    const settings = JSON.parse(
      args.split("--settings\n")[1]!.split("\n")[0]!,
    ) as {
      sandbox: {
        enabled: boolean;
        network: { allowedDomains: string[] };
        filesystem: { denyRead: string[] };
      };
    };
    // Enforced where this host can hold a run to it; switched off, and said
    // so, where it cannot (a locked-down container has no bubblewrap).
    expect(settings.sandbox.enabled).toBe((await sandboxAvailable()).ok);
    const domains = settings.sandbox.network.allowedDomains;
    expect(domains).toContain(new URL(servers.url).host);
    expect(domains).not.toContain("127.0.0.1");
    expect(domains).not.toContain("localhost");
    expect(settings.sandbox.network.allowedDomains).toContain(
      "registry.npmjs.org",
    );
    expect(settings.sandbox.filesystem.denyRead).toContain(
      join(dataDir, "repos"),
    );
    expect(settings.sandbox.filesystem.denyRead).toContain(
      join(dataDir, "secret.key"),
    );
    expect(
      settings.sandbox.filesystem.denyRead.some((p) => p.includes("/crew/bot")),
    ).toBe(false);
    const prompt = readFileSync(promptFile, "utf8");
    expect(prompt).toContain("Issue #1: Plant tulips");
    expect(prompt).toContain("Along the fence.");
    expect(prompt).toContain("bot/1-plant-tulips");

    // What the run cost in turns is kept beside what it cost in money.
    expect(run.turns).toBe(3);
    const pulls = listPulls(app.db, repo.id, { state: "open" });
    expect(pulls.length).toBe(1);
    const pull = pulls[0]!;
    expect(pull.authorName).toBe("bot");
    expect(pull.headBranch).toBe("bot/1-plant-tulips");
    expect(pull.title).toBe("Plant tulips");
    // The crew works from forks: the branch lives in the agent's own copy
    // and proposes back; the repository itself gained no branch.
    const fork = getForkOf(app.db, bot.id, repo.id)!;
    expect(fork).toBeDefined();
    expect(fork.name).toBe("garden");
    expect(pull.crossRepo).toBe(true);
    expect(pull.headRepoId).toBe(fork.id);
    expect(
      await resolveOid(
        repoDir(app.reposRoot, repo.ownerName, repo.name),
        "refs/heads/bot/1-plant-tulips",
      ),
    ).toBeUndefined();
    expect(
      await resolveOid(
        repoDir(app.reposRoot, fork.ownerName, fork.name),
        "refs/heads/bot/1-plant-tulips",
      ),
    ).toBe(pull.headOid);
    // The work reached the pull; what the sandbox left beside it (`.tmp/`,
    // added with the rest by `git add -A`) never did: the clone's exclude
    // file keeps it out of every crew commit.
    const pushed = await listPaths(
      repoDir(app.reposRoot, fork.ownerName, fork.name),
      pull.headOid,
    );
    if (!pushed.ok) throw new Error(String(pushed.error));
    expect(pushed.value.paths).toContain("CREW.md");
    expect(pushed.value.paths.some((p) => p.startsWith(".tmp/"))).toBe(false);
    expect(pull.body).toContain("Added CREW.md as asked.");
    expect(pull.body).toContain(`Closes #${issueNumber}`);
    // A tool line names the file the way the repository does — the run's
    // workdir stripped off — while a path outside the workdir is untouched.
    const log = readRunLog(dataDir, run.id).lines.join("\n");
    expect(log).toContain("→ Read CREW.md");
    expect(log).toContain("→ Bash cat /etc/hosts");
    // The run's credential is gone; the clone stays for the follow-up.
    const tokens = app.db
      .query<
        { n: number },
        []
      >("SELECT COUNT(*) AS n FROM token WHERE name LIKE 'run:%'")
      .get();
    expect(tokens?.n).toBe(0);
    expect(
      existsSync(
        join(
          workdirFor(
            dataDir,
            getAgentByName(app.db, "bot")!,
            repo,
            issueNumber,
          ),
          ".git",
        ),
      ),
    ).toBe(true);
  }, 60_000);

  test("feedback from a person resumes the session on the same branch", async () => {
    const pull = listPulls(app.db, repo.id, { state: "open" })[0]!;
    const before = listRuns(app.db, repo.id, { kind: "agent" }).length;
    // The agent's own comment is not feedback.
    expect(addComment(app, bot, repo, pull, "Working on it.").ok).toBe(true);
    await Bun.sleep(300);
    expect(listRuns(app.db, repo.id, { kind: "agent" }).length).toBe(before);
    // A person's is.
    expect(
      addComment(app, alice, repo, pull, "Also plant daffodils please.").ok,
    ).toBe(true);
    const run = await settled((r) => r.reason === "feedback");
    expect(run.state).toBe("ok");
    expect(run.summary).toMatch(/^updated pull #\d+/);
    const args = readFileSync(argsFile, "utf8");
    expect(args).toContain("--resume\nfake-1");
    const prompt = readFileSync(promptFile, "utf8");
    expect(prompt).toContain("feedback on your pull");
    expect(prompt).toContain("Also plant daffodils please.");
    expect(prompt).not.toContain("Working on it.");
    // The agent reported on the pull, and the branch moved.
    const comments = listComments(app.db, pull.id).filter(
      (c) => c.authorName === "bot",
    );
    expect(comments.map((c) => c.body)).toContain("Added CREW.md as asked.");
    // The branch moved in the fork (the pull row keeps its opening snapshot;
    // the live head is git's), and the base's snapshot of it followed.
    const fork = getForkOf(app.db, bot.id, repo.id)!;
    const tip = await resolveOid(
      repoDir(app.reposRoot, fork.ownerName, fork.name),
      `refs/heads/${pull.headBranch}`,
    );
    expect(tip).toBeDefined();
    expect(tip).not.toBe(pull.headOid);
    await Bun.sleep(300);
    expect(
      await resolveOid(
        repoDir(app.reposRoot, repo.ownerName, repo.name),
        `refs/pull/${pull.number}/head`,
      ),
    ).toBe(tip);
  }, 60_000);

  test("closing the pull removes the clone; a closed issue starts nothing", async () => {
    const pull = listPulls(app.db, repo.id, { state: "open" })[0]!;
    const dir = workdirFor(
      dataDir,
      getAgentByName(app.db, "bot")!,
      repo,
      issueNumber,
    );
    expect(existsSync(dir)).toBe(true);
    expect(setIssueState(app, alice, repo, pull, "closed").ok).toBe(true);
    const deadline = Date.now() + 5_000;
    while (existsSync(dir) && Date.now() < deadline) await Bun.sleep(50);
    expect(existsSync(dir)).toBe(false);
    const before = listRuns(app.db, repo.id, { kind: "agent" }).length;
    expect(addComment(app, alice, repo, pull, "one more thing").ok).toBe(true);
    await Bun.sleep(300);
    expect(listRuns(app.db, repo.id, { kind: "agent" }).length).toBe(before);
  }, 30_000);

  test("a pull closed without a merge has nothing to continue: its follow-up fails before it begins", async () => {
    const agent = getAgentByName(app.db, "bot")!;
    // Closed without a merge, the proposal was declined: nothing to continue.
    const closed = listPulls(app.db, repo.id, { state: "closed" }).find(
      (p) => p.mergedAt === null,
    )!;
    expect(closed).toBeDefined();
    const dead = queueAgentRun(
      app,
      repo,
      getIssue(app.db, repo.id, closed.number)!,
      agent,
      "feedback",
      alice.id,
    )!;
    const outcome = await settled((r) => r.id === dead.id);
    expect(outcome.state).toBe("failed");
    expect(outcome.summary).toBe(
      `pull #${closed.number} was closed before the run began`,
    );
  }, 30_000);

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
    const tree = await git("rev-parse", `${baseTip}^{tree}`);
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
});
