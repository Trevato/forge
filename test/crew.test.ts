/**
 * The crew loop with a stand-in for Claude Code: a script that speaks
 * stream-json, edits a file, commits and pushes — so the whole harness is
 * exercised (dispatch off the outbox, the per-run token, the clone and
 * branch, the prompt, landing the pull, the follow-up that resumes the
 * session, the bounds) without spending a cent or needing a login.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import {
  addComment,
  assignIssue,
  openIssue,
  setIssueState,
} from "../src/actions/issues.ts";
import { mergePull } from "../src/actions/pulls.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { sandboxAvailable } from "../src/crew/sandbox.ts";
import {
  queueAgentRun,
  startCrew,
  type CrewHandle,
} from "../src/crew/dispatch.ts";
import { workdirFor } from "../src/crew/runner.ts";
import { startChecks, type ChecksHandle } from "../src/checks/service.ts";
import { getAgentByName, setCrewRole } from "../src/core/agents.ts";
import { listReviews } from "../src/core/reviews.ts";
import { getIssue, listComments } from "../src/core/issues.ts";
import { listPulls } from "../src/core/pulls.ts";
import { resolveOid } from "../src/git/merge.ts";
import { listPaths } from "../src/git/read.ts";
import { repoDir } from "../src/git/repos.ts";
import { getForkOf, type Repo } from "../src/core/repos.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { readRunLog } from "../src/runs/log.ts";
import { spellings, stripForgeDirs } from "../src/runs/paths.ts";

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
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let crew: CrewHandle;
  let checks: ChecksHandle;
  let alice: User;
  let bot: User;
  let repo: Repo;
  let argsFile: string;
  let promptFile: string;

  async function settled(
    where: (run: Run) => boolean,
    timeoutMs = 30_000,
  ): Promise<Run> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = listRuns(app.db, repo.id, { kind: "agent" }).find(where);
      if (
        run &&
        (run.state === "ok" ||
          run.state === "failed" ||
          run.state === "cancelled")
      )
        return run;
      await Bun.sleep(100);
    }
    throw new Error("agent run did not settle");
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-crew-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    argsFile = join(dataDir, "fake.args");
    promptFile = join(dataDir, "fake.prompt");
    // The stand-in: records its argv and prompt, does the work, pushes.
    const fake = join(dataDir, "fake-claude");
    writeFileSync(
      fake,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
printf '%s\\n' "$@" > "${argsFile}"
IFS= read -r first; printf '%s\\n' "$first" > "${promptFile}"
echo '{"type":"system","subtype":"init","session_id":"fake-1","model":"fake"}'
if grep -q LIMIT-ME "${promptFile}" && [ ! -f PAUSED.md ]; then
  echo "half-done" > PAUSED.md
  echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"You\u2019ve hit your session limit \u00b7 resets 7:20am (UTC)","total_cost_usd":0.02,"num_turns":2,"session_id":"fake-1","terminal_reason":"api_error"}'
  exit 0
fi
if grep -q "Carry on from where you stopped" "${promptFile}"; then
  if [ -f PAUSED.md ]; then kept=yes; else kept=no; fi
  echo '{"type":"assistant","message":{"content":[{"type":"text","text":"PAUSED.md present: '"$kept"'"}]}}'
fi
if grep -q DECLINE-ME "${promptFile}"; then
  echo "half-done edit" > SHOULD-NOT-LAND.md
  echo '{"type":"result","subtype":"success","is_error":false,"result":"DECLINED: this is out of scope for me.","total_cost_usd":0.005,"num_turns":1,"session_id":"fake-2","terminal_reason":"completed"}'
  exit 0
fi
if grep -q DONE-ON-MAIN "${promptFile}"; then
  tip=$(git rev-parse HEAD)
  if grep -q NAMED "${promptFile}"; then said="already done on main in $tip"
  elif grep -q ABSENT "${promptFile}"; then said="already done on main in deadbeefdeadbeef"
  else said="already done on main"; fi
  printf '{"type":"result","subtype":"success","is_error":false,"result":"DECLINED: %s","total_cost_usd":0.005,"num_turns":1,"session_id":"fake-4","terminal_reason":"completed"}\n' "$said"
  exit 0
fi
if grep -q "You are the reviewer on this crew" "${promptFile}"; then
  path=$(grep -o 'api/v1/repos/[^"\\]*/review-states' "${promptFile}" | head -1)
  curl -sS -X POST -H "authorization: Bearer $FORGE_TOKEN" -H "content-type: application/json" "\${FORGE_URL%/}/$path" -d '{"state":"changes_requested","body":"Name the fence."}' > "${dataDir}/review.out"
  echo '{"type":"result","subtype":"success","is_error":false,"result":"Reviewed.","total_cost_usd":0.004,"num_turns":1,"session_id":"fake-3","terminal_reason":"completed"}'
  exit 0
fi
if grep -q "The check on your pull" "${promptFile}"; then echo "daffodils" >> CREW.md; fi
echo "work by the crew $(date +%s%N)" >> CREW.md
# What a sandboxed shell leaves beside the code: a temp directory with a
# package cache in it. Never the work; the clone's exclude keeps it out.
mkdir -p .tmp/cache && echo "junk" > .tmp/cache/leftover
git add -A && git commit -qm "crew work" && git push -q -u origin HEAD
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Added CREW.md."},{"type":"tool_use","name":"Read","input":{"file_path":"'"$(pwd)"'/CREW.md"}},{"type":"tool_use","name":"Bash","input":{"command":"cat /etc/hosts"}},{"type":"tool_use","name":"Bash","input":{"command":"git push"}}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"Added CREW.md as asked.","total_cost_usd":0.01,"num_turns":3,"session_id":"fake-1","terminal_reason":"completed"}'
`,
    );
    chmodSync(fake, 0o755);
    checks = startChecks(app, { forgeUrl: servers.url, concurrency: 1 });
    crew = await startCrew(app, {
      forgeUrl: servers.url,
      localUrl: servers.url,
      binary: fake,
      concurrency: 1,
      budgetUsd: 1,
      runTimeoutMs: 60_000,
    });
    const a = await createUser(app.db, {
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createAgent(app, alice, {
      username: "bot",
      brief: "Be brief.",
    });
    if (!made.ok) throw new Error(String(made.error));
    bot = made.value.user;
    const created = await createRepo(app, alice, {
      name: "garden",
      visibility: "private",
    });
    if (!created.ok) throw new Error(String(created.error));
    repo = created.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# garden\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    expect(addToCrew(app, alice, repo, "bot").ok).toBe(true);
  }, 30_000);

  afterAll(async () => {
    await crew.stop();
    await checks.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

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
    expect(settings.sandbox.network.allowedDomains).toContain("localhost");
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

  test("an agent may decline: nothing lands, the reason is on the run, not a comment", async () => {
    const issue = openIssue(app, alice, repo, {
      title: "Do something shady",
      body: "DECLINE-ME",
    });
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;
    expect(assignIssue(app, alice, repo, issue.value, bot).ok).toBe(true);
    const run = await settled((r) => r.issueId === issue.value.id);
    expect(run.state).toBe("failed");
    expect(run.summary).toBe("declined: this is out of scope for me.");
    // No pull for it, no branch pushed, and the half-done edit stayed home.
    const pulls = listPulls(app.db, repo.id, { state: "open" });
    expect(pulls.some((p) => p.title === "Do something shady")).toBe(false);
    const tip = await resolveOid(
      repoDir(app.reposRoot, repo.ownerName, repo.name),
      `refs/heads/${run.branch}`,
    );
    expect(tip).toBeUndefined();
    const comments = listComments(app.db, issue.value.id);
    expect(comments.some((c) => c.authorName === "bot")).toBe(false);
  }, 60_000);

  test("a decline naming a commit on main is an already-done run; without one that is on the base it is a decline", async () => {
    const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
    const main = await resolveOid(dir, `refs/heads/${repo.defaultBranch}`);
    const ask = async (title: string, marker: string) => {
      const issue = openIssue(app, alice, repo, {
        title,
        body: `DONE-ON-MAIN ${marker}`,
      });
      if (!issue.ok) throw new Error("issue");
      expect(assignIssue(app, alice, repo, issue.value, bot).ok).toBe(true);
      return settled((r) => r.issueId === issue.value.id);
    };
    const named = await ask("Already built", "NAMED");
    expect(named.state).toBe("ok");
    expect(named.summary).toBe(`already done: ${main}`);
    expect(named.summary).toMatch(/^already done: [0-9a-f]{40}$/);
    const none = await ask("Built, says who", "NONE");
    expect(none.state).toBe("failed");
    expect(none.summary).toBe("declined: already done on main");
    const absent = await ask("Built somewhere", "ABSENT");
    expect(absent.state).toBe("failed");
    expect(absent.summary).toBe(
      "declined: already done on main in deadbeefdeadbeef",
    );
  }, 90_000);

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

  test("a pull merged before its run begins: the follow-up branches from the default branch and lands as a new pull", async () => {
    const issue = openIssue(app, alice, repo, {
      title: "Prune roses",
      body: "Before spring.",
    });
    if (!issue.ok) throw new Error(String(issue.error));
    expect(assignIssue(app, alice, repo, issue.value, bot).ok).toBe(true);
    const built = await settled(
      (r) => r.issueId === issue.value.id && r.reason === "assigned",
    );
    expect(built.summary).toMatch(/^opened pull #\d+/);
    const pull = listPulls(app.db, repo.id, { state: "open" }).find(
      (p) => p.headBranch === `bot/${issue.value.number}-prune-roses`,
    )!;
    expect(pull).toBeDefined();
    const merged = await mergePull(app, alice, repo, pull, "merge");
    expect(merged.ok).toBe(true);

    // The race: feedback queued while the pull was open, begun after the
    // merge. The branch is spent; the work goes on a fresh one from the
    // default branch, in the same session, and lands as a pull of its own.
    const pullIssue = getIssue(app.db, repo.id, pull.number)!;
    const agent = getAgentByName(app.db, "bot")!;
    // The word that queued it, said after the run that opened the pull.
    await Bun.sleep(5);
    app.db
      .query(
        "INSERT INTO comment (id, issue_id, author_id, body) VALUES (?1, ?2, ?3, 'Shorter, please.')",
      )
      .run(`c-${pull.number}`, pullIssue.id, alice.id);
    const queued = queueAgentRun(
      app,
      repo,
      pullIssue,
      agent,
      "feedback",
      alice.id,
    );
    expect(queued).toBeDefined();
    const run = await settled((r) => r.id === queued!.id);
    expect(run.state).toBe("ok");
    expect(run.summary).toMatch(/^opened pull #\d+/);
    expect(run.branch).toBe(`bot/${pull.number}-prune-roses`);
    expect(readFileSync(promptFile, "utf8")).toContain(
      `Pull #${pull.number} has been merged`,
    );
    expect(readFileSync(argsFile, "utf8")).toContain("--resume\nfake-1");
    const next = listPulls(app.db, repo.id, { state: "open" }).find(
      (p) => p.headBranch === run.branch,
    )!;
    expect(next).toBeDefined();
    expect(next.baseBranch).toBe(repo.defaultBranch);
    expect(next.body).toContain(`Continues #${pull.number}`);
    expect(next.body).not.toContain("Closes #");

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
  }, 90_000);

  test("a pull whose branch lives in the repository itself is not the crew's to move", async () => {
    // A branch a person pushed to the repository, proposed the old way.
    const seeded = await commitToBranch(app, alice, repo, {
      branch: "alice/hedge",
      message: "A hedge",
      files: [{ path: "HEDGE.md", content: "# hedge\n" }],
    });
    expect(seeded.ok).toBe(true);
    const opened = await openPull(app, alice, repo, {
      title: "A hedge",
      baseBranch: repo.defaultBranch,
      headBranch: "alice/hedge",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    expect(assignIssue(app, alice, repo, opened.value, bot).ok).toBe(true);
    const run = await settled((r) => r.issueId === opened.value.id);
    expect(run.state).toBe("failed");
    expect(run.summary).toContain("lives in the repository itself");
    expect(run.costUsd).toBe(0);
  }, 30_000);

  test("a run the provider turns away pauses, and carries on in its clone when the limit lifts", async () => {
    const issue = openIssue(app, alice, repo, {
      title: "Water the ferns",
      body: "LIMIT-ME: once a day, before noon.",
    });
    if (!issue.ok) throw new Error(String(issue.error));
    expect(assignIssue(app, alice, repo, issue.value, bot).ok).toBe(true);
    const paused = await settled(
      (r) => r.issueId === issue.value.id && r.attempt === 0,
    );
    expect(paused.state).toBe("cancelled");
    expect(paused.summary).toMatch(
      /^paused: the 5-hour window is full until 07:20 UTC; resumes 07:21 UTC/,
    );
    expect(paused.summary).toContain("resumes 07:21 UTC");
    expect(paused.sessionId).toBe("fake-1");
    // Nothing landed: no branch pushed, no pull.
    expect(
      listPulls(app.db, repo.id, { state: "open" }).some(
        (p) => p.headBranch === `bot/${issue.value.number}-water-the-ferns`,
      ),
    ).toBe(false);
    // The task waits for the reset, once.
    const waiting = listRuns(app.db, repo.id, { kind: "agent" }).find(
      (r) => r.issueId === issue.value.id && r.state === "queued",
    )!;
    expect(waiting).toBeDefined();
    expect(waiting.attempt).toBe(1);
    expect(waiting.reason).toBe("assigned");
    expect(new Date(waiting.notBefore!).getTime()).toBeGreaterThan(Date.now());
    expect(waiting.summary).toContain("resumes 07:21 UTC");
    // The half-done work is still in the clone.
    const dir = workdirFor(
      dataDir,
      getAgentByName(app.db, "bot")!,
      repo,
      issue.value.number,
    );
    expect(existsSync(join(dir, "PAUSED.md"))).toBe(true);

    // The limit lifts. (The forge waits for the clock; the test does not.)
    app.db
      .query("UPDATE run SET not_before = NULL WHERE id = ?1")
      .run(waiting.id);
    const resumed = await settled((r) => r.id === waiting.id);
    expect(resumed.state).toBe("ok");
    expect(resumed.summary).toMatch(/^opened pull #\d+/);
    expect(readFileSync(argsFile, "utf8")).toContain("--resume\nfake-1");
    const prompt = readFileSync(promptFile, "utf8");
    expect(prompt).toContain("Carry on from where you stopped");
    expect(prompt).toContain(`Issue #${issue.value.number}: Water the ferns`);
    const log = readRunLog(dataDir, resumed.id).lines.join("\n");
    expect(log).toContain("clone kept as it was left");
    expect(log).toContain("PAUSED.md present: yes");
  }, 90_000);

  test("a failing check on the agent's pull comes back to it, and it fixes it", async () => {
    const made = await createRepo(app, alice, {
      name: "orchard",
      visibility: "private",
    });
    if (!made.ok) throw new Error(String(made.error));
    const orchard = made.value;
    const seeded = await commitToBranch(app, alice, orchard, {
      message: "Start",
      files: [
        { path: "README.md", content: "# orchard\n" },
        {
          path: "forge.json",
          content:
            '{"check": {"run": "grep -q daffodils CREW.md", "install": ""}}\n',
        },
      ],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    expect(addToCrew(app, alice, orchard, "bot").ok).toBe(true);
    const issue = openIssue(app, alice, orchard, {
      title: "Plant daffodils",
      body: "Along the wall.",
    });
    if (!issue.ok) throw new Error(String(issue.error));
    expect(assignIssue(app, alice, orchard, issue.value, bot).ok).toBe(true);
    const runs = (kind: "agent" | "check") =>
      listRuns(app.db, orchard.id, { kind, limit: 50 });
    const until = async <T>(
      find: () => T | undefined,
      timeoutMs = 60_000,
    ): Promise<T> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = find();
        if (found !== undefined) return found;
        await Bun.sleep(100);
      }
      throw new Error("did not happen in time");
    };
    const built = await until(() =>
      runs("agent").find((r) => r.reason === "assigned" && r.state === "ok"),
    );
    expect(built.summary).toMatch(/^opened pull #\d+/);
    // The pull's own commit is checked in `pull-<number>`; the initial
    // commit to the default branch (no CREW.md yet) is checked too, in
    // `production`, and fails for its own reason (no such file) — so the
    // pull's check is picked out by its environment, not just "failed".
    const pullNumber = Number(built.summary.match(/#(\d+)/)?.[1]);
    const pullChecks = () =>
      listRuns(app.db, orchard.id, {
        kind: "check",
        env: `pull-${pullNumber}`,
        limit: 50,
      });
    // The forge checks the pull: no daffodils yet.
    const failed = await until(() =>
      pullChecks().find((r) => r.state === "failed"),
    );
    expect(failed.summary).toBe("check failed: check exited with code 1");
    // …and the agent hears about it, with the log, and answers.
    const fixed = await until(() =>
      runs("agent").find(
        (r) => r.reason === "check_failed" && r.state === "ok",
      ),
    );
    expect(fixed.summary).toMatch(/^updated pull #\d+/);
    const prompt = readFileSync(promptFile, "utf8");
    expect(prompt).toContain("The check on your pull #");
    expect(prompt).toContain("check exited with code 1");
    expect(prompt).toContain("The end of the check log:");
    const passed = await until(() =>
      pullChecks().find((r) => r.state === "ok"),
    );
    expect(passed.summary).toMatch(/^check passed/);
  }, 120_000);

  test("a reviewer's run that posts its verdict is ok, though it pushes nothing", async () => {
    const made = await createAgent(app, alice, { username: "rev" });
    if (!made.ok) throw new Error(String(made.error));
    expect(addToCrew(app, alice, repo, "rev").ok).toBe(true);
    setCrewRole(app.db, repo.id, made.value.user.id, "reviewer");
    const branch = await commitToBranch(app, alice, repo, {
      branch: "fence",
      base: "main",
      message: "A fence",
      files: [{ path: "FENCE.md", content: "a fence\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "A fence",
      baseBranch: "main",
      headBranch: "fence",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const issue = getIssue(app.db, repo.id, opened.value.number)!;
    expect(queueAgentRun(app, repo, issue, made.value, "review")).toBeDefined();

    const run = await settled(
      (r) => r.reason === "review" && r.issueId === issue.id,
    );
    expect(run.state).toBe("ok");
    expect(run.summary).toBe("reviewed: changes requested");
    expect(
      listReviews(app.db, issue.id).map((r) => [r.authorId, r.state]),
    ).toEqual([[made.value.user.id, "changes_requested"]]);
    // Nothing pushed and nothing said on the pull: the verdict is the word.
    expect(listComments(app.db, issue.id)).toHaveLength(0);

    // A second pass reads afresh: no earlier session carries an older
    // head into it, and the same verdict again is not a second review.
    expect(queueAgentRun(app, repo, issue, made.value, "review")).toBeDefined();
    const again = await settled(
      (r) => r.reason === "review" && r.issueId === issue.id && r.id !== run.id,
    );
    expect(again.state).toBe("ok");
    expect(readFileSync(argsFile, "utf8")).not.toContain("--resume");
    expect(listReviews(app.db, issue.id)).toHaveLength(1);
  }, 60_000);
});
