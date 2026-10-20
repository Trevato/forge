/**
 * The crew with a stand-in Claude Code: what it declines, and what is not its to move.
 * The stand-in forge is `helpers/crew-standin.ts`; split from
 * `crew.test.ts` so each part runs apart (#1798).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { App } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { listComments } from "../src/core/issues.ts";
import { listPulls } from "../src/core/pulls.ts";
import type { Run } from "../src/core/runs.ts";
import { resolveOid } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";
import {
  agentRunSettled,
  startStandInCrew,
  stopStandInCrew,
  type StandInCrew,
} from "./helpers/crew-standin.ts";

describe("the crew, with a stand-in Claude Code: declines", () => {
  let standIn: StandInCrew;
  let app: App;
  let alice: User;
  let bot: User;
  let repo: Repo;

  const settled = (where: (run: Run) => boolean, timeoutMs?: number) =>
    agentRunSettled(app, repo, where, timeoutMs);

  beforeAll(async () => {
    // The pump ticks every 50 ms, not every five seconds: a run starts at once.
    standIn = await startStandInCrew({ tickMs: 50 });
    ({ app, alice, bot, repo } = standIn);
  }, 30_000);

  afterAll(() => stopStandInCrew(standIn));

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
});
