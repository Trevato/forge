/**
 * Feedback from a person resumes the stand-in session on the same branch.
 * One forge of its own, apart from crew.test.ts (the assignment).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { App } from "../src/app.ts";
import { addComment, assignIssue, openIssue } from "../src/actions/issues.ts";
import { listComments } from "../src/core/issues.ts";
import { listPulls } from "../src/core/pulls.ts";
import { resolveOid } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";
import { getForkOf, type Repo } from "../src/core/repos.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import type { User } from "../src/core/users.ts";
import {
  agentRunSettled,
  startStandInCrew,
  stopStandInCrew,
  type StandInCrew,
} from "./helpers/crew-standin.ts";

describe("the crew resumes on feedback", () => {
  let standIn: StandInCrew;
  let app: App;
  let alice: User;
  let bot: User;
  let repo: Repo;
  let argsFile: string;
  let promptFile: string;

  const settled = (where: (run: Run) => boolean, timeoutMs?: number) =>
    agentRunSettled(app, repo, where, timeoutMs);

  beforeAll(async () => {
    standIn = await startStandInCrew({ tickMs: 50 });
    ({ app, alice, bot, repo, argsFile, promptFile } = standIn);
  }, 30_000);

  afterAll(() => stopStandInCrew(standIn));

  /** The assignment, run to its pull: the start the later tests build on. */
  beforeAll(async () => {
    const issue = openIssue(app, alice, repo, {
      title: "Plant tulips",
      body: "Along the fence.",
    });
    if (!issue.ok) throw new Error("issue not opened");
    assignIssue(app, alice, repo, issue.value, bot);
    const run = await settled((r) => r.reason === "assigned");
    expect(run.state).toBe("ok");
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
});
