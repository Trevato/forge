/**
 * A check a full disk refused, through the checks service and the crew
 * (#11799): its step says the one line, the check is cancelled as the
 * machine's and queued again, and its builder hears no check_failed.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../src/app.ts";
import type { User } from "../src/core/users.ts";
import { addToCrew } from "../src/actions/crew.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { usedRefusal } from "../src/apps/disk_guard.ts";
import type { runStep } from "../src/apps/process.ts";
import { DISK_USED_SUMMARY, listRuns } from "../src/core/runs.ts";
import { err, ok } from "../src/kernel/result.ts";
import { startStandInCrew, stopStandInCrew, type StandInCrew } from "./helpers/crew-standin.ts";

const REFUSAL = `check ${usedRefusal("/", { freeBytes: 19, totalBytes: 100 })}`;

describe("a pull's check the disk refused, through the service", () => {
  let standIn: StandInCrew;
  let app: App;
  let alice: User;
  let bot: User;
  let refusals = 0;

  // The pull's checkout holds CREW.md; its first check meets a disk at 81% used, later ones pass.
  const checkStep: typeof runStep = async (_name, command, options) => {
    options.log(`$ ${command}`);
    if (!existsSync(join(options.cwd, "CREW.md")) || refusals >= 1) return ok();
    refusals++;
    options.log(REFUSAL);
    return err(REFUSAL);
  };

  beforeAll(async () => {
    standIn = await startStandInCrew({ tickMs: 50, checkStep });
    ({ app, alice, bot } = standIn);
  }, 30_000);

  afterAll(() => stopStandInCrew(standIn));

  const until = async <T>(find: () => T | undefined, timeoutMs = 20_000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = find();
      if (found !== undefined) return found;
      await Bun.sleep(20);
    }
    throw new Error("did not happen in time");
  };

  test("refused once: cancelled, queued again, never red, no rework", async () => {
    const made = await createRepo(app, alice, { name: "kiln", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    const kiln = made.value;
    const seeded = await commitToBranch(app, alice, kiln, {
      message: "Start",
      files: [
        { path: "README.md", content: "# kiln\n" },
        { path: "forge.json", content: '{"check": {"run": "exit 0", "install": ""}}\n' },
      ],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    expect(addToCrew(app, alice, kiln, "bot").ok).toBe(true);
    const issue = openIssue(app, alice, kiln, { title: "Fire the kiln", body: "Slowly." });
    if (!issue.ok) throw new Error(String(issue.error));
    expect(assignIssue(app, alice, kiln, issue.value, bot).ok).toBe(true);

    const built = await until(() =>
      listRuns(app.db, kiln.id, { kind: "agent", limit: 50 }).find((r) => r.reason === "assigned" && r.state === "ok"),
    );
    const pullNumber = Number(built.summary.match(/#(\d+)/)?.[1]);
    const pullChecks = () => listRuns(app.db, kiln.id, { kind: "check", env: `pull-${pullNumber}`, limit: 50 });

    const first = await until(() => pullChecks().find((r) => r.attempt === 0 && r.state === "cancelled"));
    expect(first.summary).toBe(DISK_USED_SUMMARY);
    const retry = await until(() => pullChecks().find((r) => r.attempt === 1 && r.state === "ok"));
    expect(retry.commitOid).toBe(first.commitOid);
    expect(pullChecks().some((r) => r.state === "failed")).toBe(false);
    expect(listRuns(app.db, kiln.id, { kind: "agent", limit: 50 }).filter((r) => r.reason === "check_failed")).toHaveLength(0);
  }, 30_000);
});
