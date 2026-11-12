/**
 * An agent run's log ends with one `timing:` line: where the run's time went,
 * lap by lap, on the path that started it — a finished run and a failed
 * clone alike. A clock that ticks a second per read makes the laps exact.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { listPulls } from "../src/core/pulls.ts";
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
        (!paused || (r.state === "cancelled" && r.summary.startsWith("paused:"))),
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

  test("a pull opened at the first push gets its line before the end line", async () => {
    rmSync(join(standIn.dataDir, "release"), { force: true });
    // The stand-in lingers after its push; release it once the pull is open.
    const releasing = (async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const open = listPulls(standIn.app.db, standIn.repo.id, {
          state: "open",
          limit: 50,
        });
        if (open.some((p) => p.title === "Sow the beans")) break;
        await Bun.sleep(100);
      }
      writeFileSync(join(standIn.dataDir, "release"), "");
    })();
    const { run, lines, timing } = await runOn("Sow the beans", undefined, "LINGER-ME");
    await releasing;
    expect(run.state).toBe("ok");
    expect(timing).toHaveLength(2);
    expect(timing[0]).toMatch(
      /^timing: first push \d+\.\ds after the run started — clone \d+\.\ds · brief \d+\.\ds · harness to first push \d+\.\ds$/,
    );
    expect(lines.indexOf(timing[0]!)).toBeLessThan(lines.indexOf(timing[1]!));
    expect(lines.at(-1)).toBe(timing[1]!);
  }, 60_000);

  test("a run whose clone cannot be prepared still ends with the line", async () => {
    const { run, lines, timing } = await runOn("Prune the roses", (number) => {
      const agent = getAgent(standIn.app.db, standIn.bot.id);
      if (!agent) throw new Error("no agent");
      // A kept clone that reads as a repository but refuses every
      // transport: it is reused, and its fetch fails. (A `.git` that is no
      // repository is moved aside and cloned afresh, #6263.)
      const dir = workdirFor(standIn.app.config.dataDir, agent, standIn.repo, number);
      mkdirSync(dir, { recursive: true });
      for (const args of [["init", "--quiet"], ["config", "protocol.allow", "never"]]) {
        const done = Bun.spawnSync(["git", ...args], { cwd: dir });
        if (done.exitCode !== 0) throw new Error(done.stderr.toString());
      }
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
