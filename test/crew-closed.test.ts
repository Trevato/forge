/**
 * Closing a pull removes the agent's clone and starts nothing; a follow-up on a
 * pull closed without a merge fails before it begins.
 * One forge of its own, apart from crew.test.ts (the assignment).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { App } from "../src/app.ts";
import {
  addComment,
  assignIssue,
  openIssue,
  setIssueState,
} from "../src/actions/issues.ts";
import { queueAgentRun } from "../src/crew/dispatch.ts";
import { workdirFor } from "../src/crew/runner.ts";
import { getAgentByName } from "../src/core/agents.ts";
import { getIssue } from "../src/core/issues.ts";
import { listPulls } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import type { User } from "../src/core/users.ts";
import {
  agentRunSettled,
  startStandInCrew,
  stopStandInCrew,
  type StandInCrew,
} from "./helpers/crew-standin.ts";

describe("the crew when a pull closes", () => {
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

  let issueNumber = 0;

  /** The assignment, run to its pull: the start the later tests build on. */
  beforeAll(async () => {
    const issue = openIssue(app, alice, repo, {
      title: "Plant tulips",
      body: "Along the fence.",
    });
    if (!issue.ok) throw new Error("issue not opened");
    issueNumber = issue.value.number;
    assignIssue(app, alice, repo, issue.value, bot);
    const run = await settled((r) => r.reason === "assigned");
    expect(run.state).toBe("ok");
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
});
