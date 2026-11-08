/**
 * The crew with a stand-in Claude Code: a dropped connection is retried,
 * not judged (#1613).
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { App } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { listPulls } from "../src/core/pulls.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import { MAX_PAUSES } from "../src/crew/limits.ts";
import { isNetworkError, NETWORK_PAUSE_MS } from "../src/crew/network.ts";
import { isRateLimited } from "../src/crew/limits.ts";
import { interruptionOf } from "../src/crew/interrupted.ts";
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
  contextTokens: 0,
  contextWindow: 0,
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
    // A typographic apostrophe, and the other ways a dead network is worded.
    for (const result of [
      "API Error: Can\u2019t reach the API server",
      "Unable to connect to API (FailedToOpenSocket)",
      "getaddrinfo ENETUNREACH api.anthropic.com",
    ])
      expect(isNetworkError(outcome({ result }))).toBe(true);
    expect(
      isNetworkError(outcome({ result: "You hit your session limit" })),
    ).toBe(false);
    expect(isNetworkError(outcome({ ok: true, result: "EAI_AGAIN" }))).toBe(
      false,
    );
  });

  test("matches the exact wording of the failed quorum run 01m2vkf45fq3wkrbd7373yr2ah (#3123)", () => {
    const logged =
      "API Error: Can't reach the API server — check your internet or DNS (EAI_AGAIN) (api_error)";
    expect(isNetworkError(outcome({ result: logged }))).toBe(true);
    expect(isNetworkError(outcome({ result: "", reason: logged }))).toBe(true);
    // The same sentence without the code, and with a typographic apostrophe.
    const bare = "API Error: Can’t reach the API server — check your internet";
    expect(isNetworkError(outcome({ result: bare }))).toBe(true);
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

  test("a wrap-up that lost its connection asks again and lands the work", async () => {
    const issue = openIssue(app, alice, repo, {
      title: "Flaky wrap-up",
      body: "WRAP-FLAKE",
    });
    if (!issue.ok) throw new Error(String(issue.error));
    expect(assignIssue(app, alice, repo, issue.value, bot).ok).toBe(true);
    const run = await agentRunSettled(
      app,
      repo,
      (r) => r.issueId === issue.value.id,
    );
    expect(run.summary).toContain("opened pull");
    expect(run.summary).not.toContain("network");
    expect(existsSync(join(standIn.dataDir, "wrapflaked"))).toBe(true);
  }, 60_000);

  test("a wrap-up that never reconnects pauses the run instead of judging it", async () => {
    const issue = openIssue(app, alice, repo, {
      title: "Wrap-up down",
      body: "WRAP-DOWN",
    });
    if (!issue.ok) throw new Error(String(issue.error));
    expect(assignIssue(app, alice, repo, issue.value, bot).ok).toBe(true);
    const until = Date.now() + 30_000;
    let found: Run | undefined;
    while (Date.now() < until && !found) {
      found = listRuns(app.db, repo.id, { kind: "agent" }).find(
        (r) => r.issueId === issue.value.id && r.state === "cancelled",
      );
      if (!found) await Bun.sleep(50);
    }
    expect(found?.summary).toStartWith("paused: network error");
    rmSync(join(standIn.dataDir, "wrapdown"));
  }, 60_000);

  test("a run paused after its first push keeps its pull saying it is in progress", async () => {
    const issue = openIssue(app, alice, repo, {
      title: "Pause after push",
      body: "PUSH-THEN-DOWN",
    });
    if (!issue.ok) throw new Error(String(issue.error));
    expect(assignIssue(app, alice, repo, issue.value, bot).ok).toBe(true);
    const until = Date.now() + 40_000;
    let paused: Run | undefined;
    while (paused === undefined && Date.now() < until) {
      paused = listRuns(app.db, repo.id, { kind: "agent" }).find(
        (r) => r.issueId === issue.value.id && r.state === "cancelled",
      );
      if (paused === undefined) await Bun.sleep(50);
    }
    expect(paused?.summary).toStartWith("paused: network error");
    const pull = listPulls(app.db, repo.id, { state: "open", limit: 200 }).find(
      (p) => p.headBranch === paused!.branch,
    );
    expect(pull).toBeDefined();
    expect(pull!.body).toStartWith("In progress:");
    rmSync(join(standIn.dataDir, "down"), { force: true });
  }, 60_000);

  test("an outage that outlasts the retries pauses the run; after MAX_PAUSES it ends", async () => {
    const issue = openIssue(app, alice, repo, {
      title: "Network down",
      body: "NET-DOWN",
    });
    if (!issue.ok) throw new Error(String(issue.error));
    expect(assignIssue(app, alice, repo, issue.value, bot).ok).toBe(true);
    const mine = () =>
      listRuns(app.db, repo.id, { kind: "agent" }).filter(
        (r) => r.issueId === issue.value.id,
      );
    const waitFor = async (where: (r: Run) => boolean): Promise<Run> => {
      const until = Date.now() + 30_000;
      while (Date.now() < until) {
        const found = mine().find(where);
        if (found) return found;
        await Bun.sleep(50);
      }
      throw new Error("run did not settle: " + JSON.stringify(mine().map((r) => [r.state, r.attempt, r.summary])));
    };
    const paused = await waitFor((r) => r.state === "cancelled");
    expect(paused.summary).toStartWith("paused: network error");
    const next = await waitFor((r) => r.state === "queued");
    expect(next.attempt).toBe(1);
    const wait = Date.parse(next.notBefore ?? "") - Date.now();
    expect(wait).toBeGreaterThan(NETWORK_PAUSE_MS - 30_000);
    expect(wait).toBeLessThanOrEqual(NETWORK_PAUSE_MS);

    // The sixth pause was the last: the run that starts now ends instead.
    app.db
      .query("UPDATE run SET attempt = ?1, not_before = ?2 WHERE id = ?3")
      .run(MAX_PAUSES, new Date().toISOString(), next.id);
    const ended = await waitFor((r) => r.id === next.id && r.state === "failed");
    expect(ended.summary).not.toStartWith("paused");
    expect(ended.summary).toContain("network unreachable");
    expect(ended.summary).not.toContain("no changes pushed");
    rmSync(join(standIn.dataDir, "down"));
  }, 60_000);
});

describe("a network outage is not a provider limit", () => {
  const down = {
    result:
      "API Error: Can't reach the API server — check your internet or DNS (EAI_AGAIN)",
    reason: "api_error",
  };

  test("an unreachable API is not rate limited", () => {
    expect(isRateLimited(outcome(down))).toBe(false);
    expect(
      isRateLimited(
        outcome({ result: "429 too many requests", reason: "api_error" }),
      ),
    ).toBe(true);
  });

  test("the phrase alone reads as a network error", () => {
    expect(interruptionOf("no changes pushed: Can't reach the API server")).toBe(
      "network error",
    );
  });

  test("summaries in the other wordings of a dead network read as one", () => {
    for (const said of [
      "API Error: Can\u2019t reach the API server",
      "Unable to connect to API (FailedToOpenSocket)",
      "getaddrinfo ENETUNREACH api.anthropic.com",
      "write EPIPE",
    ])
      expect(interruptionOf(`no changes pushed: ${said} (api_error)`)).toBe(
        "network error",
      );
  });

  test("its summary reads as a network error", () => {
    expect(
      interruptionOf(`no changes pushed: ${down.result} (api_error)`),
    ).toBe("network error");
  });
});
