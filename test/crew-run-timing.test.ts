/**
 * An agent run's log ends with one `timing:` line: where the run's time went,
 * lap by lap, on the path that started it — a finished run and a failed
 * clone alike. A clock that ticks a second per read makes the laps exact.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { getAgent } from "../src/core/agents.ts";
import { workdirFor } from "../src/crew/runner.ts";
import { readRunLog } from "../src/runs/log.ts";
import {
  agentRunSettled,
  startStandInCrew,
  stopStandInCrew,
  type StandInCrew,
} from "./helpers/crew-standin.ts";

describe("an agent run's timing line", () => {
  let standIn: StandInCrew;
  let ticks = 0;

  beforeAll(async () => {
    standIn = await startStandInCrew({ now: () => 1_000 * ticks++ });
  }, 30_000);

  afterAll(() => stopStandInCrew(standIn));

  async function runOn(
    title: string,
    prepare?: (n: number) => void,
    body = "Do it.",
    paused = false,
  ) {
    const { app, alice, bot, repo } = standIn;
    const issue = openIssue(app, alice, repo, { title, body });
    if (!issue.ok) throw new Error(String(issue.error));
    prepare?.(issue.value.number);
    expect(assignIssue(app, alice, repo, issue.value, bot).ok).toBe(true);
    const run = await agentRunSettled(
      app,
      repo,
      (r) =>
        r.issueId === issue.value.id &&
        (!paused || r.summary.startsWith("paused:")),
      60_000,
    );
    const lines = readRunLog(standIn.dataDir, run.id).lines;
    return { run, lines, timing: lines.filter((l) => l.startsWith("timing:")) };
  }

  test("a finished run ends with the laps in order", async () => {
    const { run, lines, timing } = await runOn("Water the ferns");
    expect(run.state).toBe("ok");
    expect(timing).toHaveLength(1);
    expect(lines.at(-1)).toBe(timing[0]!);
    expect(timing[0]!).toMatch(
      /^timing: run ended \d+\.\ds after the run started — clone \d+\.\ds · brief \d+\.\ds · harness \d+\.\ds$/,
    );
  }, 30_000);

  test("a run whose clone cannot be prepared still ends with the line", async () => {
    const { run, lines, timing } = await runOn("Prune the roses", (number) => {
      const agent = getAgent(standIn.app.db, standIn.bot.id);
      if (!agent) throw new Error("no agent");
      // A `.git` that is no repository: the fetch of a kept clone fails.
      mkdirSync(
        join(
          workdirFor(standIn.app.config.dataDir, agent, standIn.repo, number),
          ".git",
        ),
        { recursive: true },
      );
    });
    expect(run.state).toBe("failed");
    expect(timing).toHaveLength(1);
    expect(lines.at(-1)).toBe(timing[0]!);
    expect(timing[0]!).toMatch(/after the run started — clone \d+\.\ds$/);
  }, 30_000);

  test("a run paused by an outage keeps its harness lap, one line last", async () => {
    const { run, lines, timing } = await runOn("Network out", undefined, "NET-DOWN", true);
    expect(run.state).toBe("cancelled");
    expect(timing).toHaveLength(1);
    expect(lines.at(-1)).toBe(timing[0]!);
    expect(timing[0]!).toMatch(/clone \d+\.\ds · brief \d+\.\ds · harness \d+\.\ds$/);
    rmSync(join(standIn.dataDir, "down"), { force: true });
  }, 90_000);

  test("a wrap-up outage keeps the harness and wrap-up laps, one line last", async () => {
    const { run, lines, timing } = await runOn("Wrap down", undefined, "WRAP-DOWN", true);
    expect(run.state).toBe("cancelled");
    expect(timing).toHaveLength(1);
    expect(lines.at(-1)).toBe(timing[0]!);
    expect(timing[0]!).toMatch(/harness \d+\.\ds · wrap-up \d+\.\ds$/);
    rmSync(join(standIn.dataDir, "wrapdown"), { force: true });
  }, 90_000);
});
