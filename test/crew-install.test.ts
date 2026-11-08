/**
 * The crew installs a clone's dependencies after the clone and before the
 * agent starts (#6572); a failed install is logged and the run goes on.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import type { InstallRunner } from "../src/crew/workdir.ts";
import { readRunLog } from "../src/runs/log.ts";
import {
  agentRunSettled,
  startStandInCrew,
  stopStandInCrew,
  type StandInCrew,
} from "./helpers/crew-standin.ts";

const FILES = [
  { path: "package.json", content: "{}\n" },
  { path: "bun.lock", content: "lock\n" },
];

async function oneRun(standIn: StandInCrew): Promise<string> {
  const { app, alice, bot, repo } = standIn;
  const issue = openIssue(app, alice, repo, { title: "Weed", body: "x" });
  if (!issue.ok) throw new Error("issue");
  expect(assignIssue(app, alice, repo, issue.value, bot).ok).toBe(true);
  const run = await agentRunSettled(app, repo, () => true, 30_000);
  return readRunLog(app.config.dataDir, run.id).lines.join("\n");
}

describe("the crew installs dependencies before the agent starts", () => {
  const stands: StandInCrew[] = [];
  afterAll(async () => {
    for (const s of stands) await stopStandInCrew(s);
  });

  test("the runner is called in the clone, after the clone and before the agent", async () => {
    const calls: { cloned: boolean; agentStarted: boolean }[] = [];
    let promptFile = "";
    const installRunner: InstallRunner = async (dir) => {
      calls.push({
        cloned: existsSync(join(dir, ".git")) && existsSync(join(dir, "bun.lock")),
        agentStarted: existsSync(promptFile),
      });
      return { code: 0, stderr: "" };
    };
    const standIn = await startStandInCrew({ installRunner, files: FILES });
    stands.push(standIn);
    promptFile = standIn.promptFile;
    const log = await oneRun(standIn);
    expect(calls).toEqual([{ cloned: true, agentStarted: false }]);
    expect(existsSync(promptFile)).toBe(true);
    expect(log).toContain("dependencies installed");
  }, 60_000);

  test("a failing install is logged and the agent still starts", async () => {
    const standIn = await startStandInCrew({
      installRunner: async () => ({ code: 1, stderr: "registry down" }),
      files: FILES,
    });
    stands.push(standIn);
    const log = await oneRun(standIn);
    expect(log).toContain("dependency install failed");
    expect(log).toContain("registry down");
    expect(existsSync(standIn.promptFile)).toBe(true);
  }, 60_000);
});
