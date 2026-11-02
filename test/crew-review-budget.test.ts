/**
 * The crew with a stand-in Claude Code: a review run past its budget.
 * The stand-in forge is `helpers/crew-standin.ts`; split from
 * `crew.test.ts` so each part runs apart (#1798).
 */

import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { App } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { queueAgentRun } from "../src/crew/dispatch.ts";
import {} from "../src/core/agents.ts";
import { getIssue } from "../src/core/issues.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import {
  agentRunSettled,
  startStandInCrew,
  stopStandInCrew,
  type StandInCrew,
} from "./helpers/crew-standin.ts";

describe("the crew, with a stand-in Claude Code: review budget", () => {
  let standIn: StandInCrew;
  let app: App;
  let alice: User;
  let repo: Repo;

  const settled = (where: (run: Run) => boolean, timeoutMs?: number) =>
    agentRunSettled(app, repo, where, timeoutMs);

  beforeAll(async () => {
    standIn = await startStandInCrew({
      reviewBudgetMs: 300,
      tickMs: 50,
    });
    ({ app, alice, repo } = standIn);
  }, 30_000);

  afterAll(() => stopStandInCrew(standIn));

  test("a review run past its budget is queued again once; the second overrun fails it", async () => {
    const made = await createAgent(app, alice, { username: "slowrev" });
    if (!made.ok) throw new Error(String(made.error));
    expect(addToCrew(app, alice, repo, "slowrev").ok).toBe(true);
    seatAs(app.db, repo.id, made.value.user.id, "reviewer");
    const branch = await commitToBranch(app, alice, repo, {
      branch: "slow-fence",
      base: "main",
      message: "A slow fence",
      files: [{ path: "SLOW.md", content: "slow\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "SLOW-REVIEW fence",
      baseBranch: "main",
      headBranch: "slow-fence",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const issue = getIssue(app.db, repo.id, opened.value.number)!;
    expect(queueAgentRun(app, repo, issue, made.value, "review")).toBeDefined();

    const failed = await settled(
      (r) =>
        r.reason === "review" && r.issueId === issue.id && r.state === "failed",
    );
    expect(failed.summary).toMatch(
      /^budget: a review run took \d+ min, limit \d+$/,
    );
    const reviews = listRuns(app.db, repo.id, { kind: "agent" }).filter(
      (r) => r.reason === "review" && r.issueId === issue.id,
    );
    expect(reviews).toHaveLength(2);
    expect(reviews.find((r) => r.state === "cancelled")?.summary).toMatch(
      /^budget: a review run/,
    );
  }, 10_000);
});
