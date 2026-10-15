/**
 * The crew with a stand-in Claude Code: a dropped connection is retried,
 * not judged (#1613).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { App } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { isNetworkError } from "../src/crew/network.ts";
import type { ClaudeOutcome } from "../src/crew/claude.ts";
import {
  agentRunSettled,
  startStandInCrew,
  stopStandInCrew,
  type StandInCrew,
} from "./helpers/crew-standin.ts";

const outcome = (over: Partial<ClaudeOutcome>): ClaudeOutcome => ({
  ok: false,
  sessionId: "",
  result: "",
  costUsd: 0,
  turns: 0,
  tokensIn: 0,
  tokensOut: 0,
  reason: "error",
  ...over,
});

describe("isNetworkError", () => {
  test("names DNS and socket failures, not the work's", () => {
    expect(
      isNetworkError(
        outcome({
          result: "API Error: Can't reach the API server (EAI_AGAIN)",
        }),
      ),
    ).toBe(true);
    expect(isNetworkError(outcome({ result: "read ECONNRESET" }))).toBe(true);
    expect(
      isNetworkError(outcome({ result: "You hit your session limit" })),
    ).toBe(false);
    expect(isNetworkError(outcome({ ok: true, result: "EAI_AGAIN" }))).toBe(
      false,
    );
  });
});

describe("the crew, with a stand-in Claude Code: network errors", () => {
  let standIn: StandInCrew;
  let app: App;
  let alice: User;
  let bot: User;
  let repo: Repo;

  beforeAll(async () => {
    standIn = await startStandInCrew();
    ({ app, alice, bot, repo } = standIn);
  }, 30_000);

  afterAll(() => stopStandInCrew(standIn));

  test("a run that lost its connection asks again and lands its work", async () => {
    const issue = openIssue(app, alice, repo, {
      title: "Flaky network",
      body: "NET-FLAKE",
    });
    if (!issue.ok) throw new Error(String(issue.error));
    expect(assignIssue(app, alice, repo, issue.value, bot).ok).toBe(true);
    const run = await agentRunSettled(
      app,
      repo,
      (r) => r.issueId === issue.value.id,
    );
    expect(run.state).toBe("ok");
    expect(run.summary).toContain("opened pull");
  }, 60_000);
});
