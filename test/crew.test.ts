/**
 * The crew loop with a stand-in for Claude Code (`helpers/crew-standin.ts`):
 * one pull's life — assigned, cloned, worked, landed, fed back on, closed.
 * Feedback is in `crew-feedback.test.ts`, closing in `crew-closed.test.ts`,
 * the early pull in `crew-early.test.ts`.
 * The rest of the loop is in the other `crew-*.test.ts` files, each on a
 * forge of its own so they run apart and in parallel (#1798).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setArchivedIn } from "./helpers/archive.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../src/app.ts";
import { cancelRepoRun, requeueRepoRun } from "../src/actions/runs.ts";
import { respondAccess } from "../src/http/respond.ts";
import { errorText } from "../src/tui/screens/common.ts";
import { queueAgentRun } from "../src/crew/dispatch.ts";
import { autonomyTick } from "../src/crew/autonomy.ts";
import { proposeResolution } from "../src/crew/proposal.ts";
import { convergeFork } from "../src/crew/converge.ts";
import { convergeWords } from "../src/actions/follow.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { sandboxAvailable } from "../src/crew/sandbox.ts";
import type { CrewHandle } from "../src/crew/dispatch.ts";
import { workdirFor } from "../src/crew/runner.ts";
import { getAgentByName } from "../src/core/agents.ts";
import { listPulls } from "../src/core/pulls.ts";
import { resolveOid } from "../src/git/merge.ts";
import { listPaths } from "../src/git/read.ts";
import { repoDir } from "../src/git/repos.ts";
import { getForkOf, ARCHIVED_WHY, updateRepoSettings, type Repo } from "../src/core/repos.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import type { User } from "../src/core/users.ts";
import type { Servers } from "../src/http/server.ts";
import { readRunLog } from "../src/runs/log.ts";
import {
  agentRunSettled,
  startStandInCrew,
  stopStandInCrew,
  type StandInCrew,
} from "./helpers/crew-standin.ts";

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
    // The crew picks every 50 ms here (`tickMs`), not every five seconds.
    standIn = await startStandInCrew({ tickMs: 50 });
    ({ dataDir, app, servers, crew, alice, bot, repo, argsFile, promptFile } =
      standIn);
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

  test("an archived repository starts no new run, says why, and starts one again after Wake", async () => {
    const issue = openIssue(app, alice, repo, { title: "Mow", body: "The lawn." });
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;
    const agent = getAgentByName(app.db, "bot")!;
    // A finished run of this test's own, to be queued again.
    const own = queueAgentRun(app, repo, issue.value, agent, "assigned");
    expect(own).toBeDefined();
    cancelRepoRun(app, alice, repo, own!.id);
    const archived = setArchivedIn(app.db, repo, true);
    expect(archived.archivedAt).not.toBeNull();
    expect(queueAgentRun(app, archived, issue.value, agent, "assigned")).toBeUndefined();
    const refused = requeueRepoRun(app, alice, archived, own!.id);
    expect(refused.ok ? "" : refused.error).toBe("archived");
    // Asking for a conflict resolution starts a run too: refused the same way.
    const pull = { state: "open", id: "none", number: 1 } as Parameters<typeof proposeResolution>[3];
    expect(await proposeResolution(app, alice, archived, pull)).toMatchObject({ ok: false, error: "archived" });
    const assigned = assignIssue(app, alice, archived, issue.value, bot);
    expect(assigned.ok ? "" : assigned.error).toBe("archived");
    expect(respondAccess("archived", 422).status).toBe(409);
    expect(errorText("archived")).toBe(ARCHIVED_WHY);
    // A fresh run the crew queues on its own (attempt 0) is new too.
    const auto = { ...archived, autonomy: "autonomous" as const };
    const fresh = { notBefore: new Date().toISOString(), attempt: 0, summary: "main moved" };
    expect(queueAgentRun(app, auto, issue.value, agent, "conflict", undefined, fresh)).toBeUndefined();
    // Converge on an archived fork says so, and opens nothing.
    const converged = await convergeFork(app, archived, archived, undefined);
    expect(converged.kind).toBe("archived");
    expect(convergeWords(converged, "p/q").message).toBe(ARCHIVED_WHY);
    // An archived autonomous repository's tick queues nothing.
    const before = listRuns(app.db, archived.id, { limit: 200 }).length;
    updateRepoSettings(app.db, archived, { autonomy: "autonomous" });
    await autonomyTick(app);
    updateRepoSettings(app.db, archived, { autonomy: "off" });
    expect(listRuns(app.db, archived.id, { limit: 200 }).length).toBe(before);
    // Taking someone off is not starting a run.
    expect(assignIssue(app, alice, archived, issue.value, null).ok).toBe(true);
    const woken = setArchivedIn(app.db, archived, false);
    expect(woken.archivedAt).toBeNull();
    expect(assignIssue(app, alice, woken, issue.value, bot).ok).toBe(true);
    // The assignment after Wake queued the run the archive had refused.
    const run = listRuns(app.db, woken.id, { issueId: issue.value.id }).find(
      (r) => r.state === "queued",
    );
    expect(run).toBeDefined();
    cancelRepoRun(app, alice, woken, run!.id);
  });

  test("a run queued before Archive is cancelled with the archived line, never started; Wake does not revive it", async () => {
    const issue = openIssue(app, alice, repo, { title: "Rake", body: "The leaves." });
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;
    const agent = getAgentByName(app.db, "bot")!;
    const queued = queueAgentRun(app, repo, issue.value, agent, "assigned");
    expect(queued).toBeDefined();
    // A run carrying on after a restart, queued in the same breath on another issue.
    const other = openIssue(app, alice, repo, { title: "Weed", body: "The beds." });
    if (!other.ok) throw new Error("issue");
    const again = { notBefore: new Date().toISOString(), attempt: 1, summary: "carries on" };
    const carrying = queueAgentRun(app, repo, other.value, agent, "assigned", undefined, again);
    expect(carrying).toBeDefined();
    // Archived at once, before the crew's next pick.
    const archived = setArchivedIn(app.db, repo, true);
    const done = await settled((r) => r.id === queued!.id, 60_000);
    expect(done.state).toBe("cancelled");
    expect(done.summary).toBe(ARCHIVED_WHY);
    expect(readRunLog(dataDir, done.id).lines.join("\n")).toContain(ARCHIVED_WHY);
    // The carry-on run is not cancelled for the archive.
    const kept = await settled((r) => r.id === carrying!.id, 60_000);
    expect(kept.summary).not.toBe(ARCHIVED_WHY);
    expect(kept.state).not.toBe("cancelled");
    // The fresh run spawned nothing: its whole log is the one archived line.
    expect(readRunLog(dataDir, done.id).lines.filter((l) => l.trim() !== "").length).toBe(1);
    // Wake leaves it cancelled; a new assignment starts normally. The new
    // run is on the same issue and queued after it, so the crew's picks
    // after Wake reach the old run first: had Wake revived it, it would
    // have started (one run per issue at a time) before this one settled.
    const woken = setArchivedIn(app.db, archived, false);
    const next = queueAgentRun(app, woken, issue.value, agent, "assigned");
    expect(next).toBeDefined();
    const ran = await settled((r) => r.id === next!.id, 60_000);
    expect(ran.state).toBe("ok");
    const after = listRuns(app.db, repo.id, { issueId: issue.value.id }).find((r) => r.id === queued!.id)!;
    expect(after.state).toBe("cancelled");
    expect(after.summary).toBe(ARCHIVED_WHY);
    expect(readRunLog(dataDir, after.id).lines.filter((l) => l.trim() !== "").length).toBe(1);
  }, 120_000);
});
