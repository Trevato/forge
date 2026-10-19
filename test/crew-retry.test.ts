/**
 * A follow-up asked again because the last try pushed nothing (#2855) is
 * not skipped as having nothing new as it starts, and its prompt carries
 * the reviewer's verdict and the previous run's final answer.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { App } from "../src/app.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { getAgent } from "../src/core/agents.ts";
import { listPulls } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { submitReview } from "../src/core/reviews.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import type { User } from "../src/core/users.ts";
import { queueAgentRun } from "../src/crew/dispatch.ts";
import { RETRY_SUMMARY, SKIP_SUMMARY } from "../src/crew/guard.ts";
import {
  agentRunSettled,
  startStandInCrew,
  stopStandInCrew,
  type StandInCrew,
} from "./helpers/crew-standin.ts";

let standIn: StandInCrew;
let app: App;
let alice: User;
let bot: User;
let repo: Repo;

beforeAll(async () => {
  standIn = await startStandInCrew();
  ({ app, alice, bot, repo } = standIn);
  const issue = openIssue(app, alice, repo, { title: "Plant tulips", body: "Along the fence." });
  if (!issue.ok) throw new Error("issue not opened");
  assignIssue(app, alice, repo, issue.value, bot);
  const run = await agentRunSettled(app, repo, (r) => r.reason === "assigned");
  expect(run.state).toBe("ok");
}, 60_000);

afterAll(() => stopStandInCrew(standIn));

test("the retry runs, and is told the verdict and the last run's answer", async () => {
  const pull = listPulls(app.db, repo.id, { state: "open" })[0]!;
  const verdict = submitReview(app.db, {
    issueId: pull.id,
    authorId: alice.id,
    state: "changes_requested",
    body: "Name the fence.",
    commitOid: pull.headOid,
  });
  if (!verdict.ok) throw new Error(verdict.error);
  await Bun.sleep(20);
  // The first follow-up began after the verdict and pushed nothing.
  const first = createRun(app.db, {
    repoId: repo.id,
    kind: "agent",
    issueId: pull.id,
    actorId: bot.id,
    reason: "feedback",
  });
  claimRun(app.db, first.id);
  finishRun(app.db, first.id, { state: "ok", summary: "I could not reproduce the fence." });

  const queued = queueAgentRun(
    app, repo, pull, getAgent(app.db, bot.id)!, "feedback", undefined, undefined, undefined, true,
  );
  expect(queued?.summary).toBe(RETRY_SUMMARY);
  const run = await agentRunSettled(app, repo, (r) => r.id === queued!.id);
  expect(run.summary).not.toBe(SKIP_SUMMARY);
  expect(run.startedAt).not.toBeNull();
  const prompt = readFileSync(standIn.promptFile, "utf8");
  expect(prompt).toContain("Name the fence.");
  expect(prompt).toContain("I could not reproduce the fence.");
}, 60_000);
