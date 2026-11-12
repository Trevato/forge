/**
 * The crew with a stand-in Claude Code: a reviewer's run.
 * The stand-in forge is `helpers/crew-standin.ts`; split from
 * `crew.test.ts` so each part runs apart (#1798).
 */

import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { App } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { queueAgentRun } from "../src/crew/dispatch.ts";
import {} from "../src/core/agents.ts";
import { getIssue, listComments } from "../src/core/issues.ts";
import { listReviews } from "../src/core/reviews.ts";
import type { Run } from "../src/core/runs.ts";
import {
  agentRunSettled,
  startStandInCrew,
  stopStandInCrew,
  type StandInCrew,
} from "./helpers/crew-standin.ts";

describe("the crew, with a stand-in Claude Code: review", () => {
  let standIn: StandInCrew;
  let app: App;
  let alice: User;
  let repo: Repo;
  let argsFile: string;

  const settled = (where: (run: Run) => boolean, timeoutMs?: number) =>
    agentRunSettled(app, repo, where, timeoutMs);

  beforeAll(async () => {
    // The crew ticks every 20 ms here, not every five seconds: a queued
    // run starts at once instead of waiting out the tick (#3594).
    standIn = await startStandInCrew({ tickMs: 20 });
    ({ app, alice, repo, argsFile } = standIn);
  }, 30_000);

  afterAll(() => stopStandInCrew(standIn));

  test("a reviewer's run that posts its verdict is ok, though it pushes nothing", async () => {
    const made = await createAgent(app, alice, { username: "rev" });
    if (!made.ok) throw new Error(String(made.error));
    expect(addToCrew(app, alice, repo, "rev").ok).toBe(true);
    seatAs(app.db, repo.id, made.value.user.id, "reviewer");
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
