/**
 * A cancel is a cancel (#11229). A person cancels an agent run through the
 * action every surface calls (`cancelRepoRun`) while the agent's command has
 * forked a child and that child a grandchild. Within 2 s none of the three
 * is alive, and the run's log ends with one line saying it was cancelled,
 * and by whom.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { cancelRepoRun } from "../src/actions/runs.ts";
import { getRun, listRuns } from "../src/core/runs.ts";
import { readRunLog } from "../src/runs/log.ts";
import { cancelledBy, cancelledLine } from "../src/runs/cancelled.ts";
import { startStandInCrew, stopStandInCrew, type StandInCrew } from "./helpers/crew-standin.ts";

describe("cancelledLine", () => {
  test("is the row's summary when a person cancelled it, else nothing", () => {
    expect(cancelledBy("alice")).toBe("cancelled by alice");
    expect(cancelledLine({ state: "cancelled", summary: "cancelled by alice" })).toBe("cancelled by alice");
    expect(cancelledLine({ state: "cancelled", summary: "the pull landed" })).toBeUndefined();
    expect(cancelledLine({ state: "cancelled", summary: "cancelled by " })).toBeUndefined();
    expect(cancelledLine({ state: "failed", summary: "cancelled by alice" })).toBeUndefined();
    expect(cancelledLine(undefined)).toBeUndefined();
  });
});

/** Alive and not a zombie a parent has yet to reap. */
function alive(pid: number): boolean {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return false;
  }
  const state = stat.slice(stat.lastIndexOf(")") + 2)[0];
  return state !== "Z" && state !== "X";
}

/** Polls, never a fixed sleep: true once `done` holds, false at the deadline. */
async function within(ms: number, done: () => boolean): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await Bun.sleep(20);
  return done();
}

async function pidIn(file: string, ms: number): Promise<number> {
  const named = (): number => (existsSync(file) ? Number(readFileSync(file, "utf8").trim()) : 0);
  await within(ms, () => Number.isInteger(named()) && named() > 1);
  const pid = named();
  if (!Number.isInteger(pid) || pid <= 1) throw new Error(`${file} never named a pid`);
  return pid;
}

describe.skipIf(process.platform !== "linux")("an agent run a person cancels", () => {
  let standIn: StandInCrew;
  const started: number[] = [];

  beforeAll(async () => {
    standIn = await startStandInCrew();
  }, 30_000);

  afterAll(async () => {
    for (const pid of started)
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // gone, as it should be
      }
    await stopStandInCrew(standIn);
  });

  test("leaves no process behind within 2 s, and its log ends saying who cancelled it", async () => {
    const { app, alice, bot, repo, dataDir } = standIn;
    const issue = openIssue(app, alice, repo, { title: "Grow a tree", body: "SPAWN-TREE and wait." });
    if (!issue.ok) throw new Error(String(issue.error));
    expect(assignIssue(app, alice, repo, issue.value, bot).ok).toBe(true);

    const pids = [
      await pidIn(join(dataDir, "tree.grand"), 30_000),
      await pidIn(join(dataDir, "tree.child"), 1_000),
      await pidIn(join(dataDir, "tree.agent"), 1_000),
    ];
    started.push(...pids);
    expect(pids.every(alive)).toBe(true);

    const run = listRuns(app.db, repo.id, { kind: "agent" }).find((r) => r.issueId === issue.value.id);
    if (run === undefined) throw new Error("no agent run");
    expect(run.state).toBe("running");

    const cancelled = cancelRepoRun(app, alice, repo, run.id);
    expect(cancelled.ok).toBe(true);
    expect(await within(2_000, () => pids.every((pid) => !alive(pid)))).toBe(true);

    // The runner winds down and ends the log; the row keeps what the cancel wrote.
    const lines = (): string[] => readRunLog(dataDir, run.id).lines;
    expect(await within(15_000, () => lines().includes("cancelled by alice"))).toBe(true);
    expect(getRun(app.db, run.id)?.state).toBe("cancelled");
    expect(getRun(app.db, run.id)?.summary).toBe("cancelled by alice");
    expect(lines().filter((l) => l === "cancelled by alice")).toHaveLength(1);
    expect(lines().at(-1)).toBe("cancelled by alice");
  }, 60_000);
});
