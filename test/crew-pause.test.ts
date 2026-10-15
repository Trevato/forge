/**
 * The crew with a stand-in Claude Code: a run the provider turns away pauses and resumes.
 * The stand-in forge is `helpers/crew-standin.ts`; split from
 * `crew.test.ts` so each part runs apart (#1798).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { workdirFor } from "../src/crew/runner.ts";
import { getAgentByName } from "../src/core/agents.ts";
import { listPulls } from "../src/core/pulls.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import { readRunLog } from "../src/runs/log.ts";
import {
  agentRunSettled,
  startStandInCrew,
  stopStandInCrew,
  type StandInCrew,
} from "./helpers/crew-standin.ts";

describe("the crew, with a stand-in Claude Code: paused by the provider", () => {
  let standIn: StandInCrew;
  let dataDir: string;
  let app: App;
  let alice: User;
  let bot: User;
  let repo: Repo;
  let argsFile: string;
  let promptFile: string;

  const settled = (where: (run: Run) => boolean, timeoutMs?: number) =>
    agentRunSettled(app, repo, where, timeoutMs);

  beforeAll(async () => {
    standIn = await startStandInCrew();
    ({ dataDir, app, alice, bot, repo, argsFile, promptFile } = standIn);
  }, 30_000);

  afterAll(() => stopStandInCrew(standIn));

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
});
