/**
 * A check stopped for CPU, through the checks service and the crew (#11617):
 * the first stop of a pull's head is cancelled and queued again, its builder
 * hears nothing; the second stop in a row is red and sends check_failed.
 * The check step is stood in (`ChecksOptions.checkStep`): the stop is the
 * cell watch's own words, which no check's output can produce.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../src/app.ts";
import type { User } from "../src/core/users.ts";
import { addToCrew } from "../src/actions/crew.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { cpuBreach } from "../src/apps/contain.ts";
import type { runStep } from "../src/apps/process.ts";
import { CPU_STOP_SUMMARY, listRuns } from "../src/core/runs.ts";
import { err, ok } from "../src/kernel/result.ts";
import { startStandInCrew, stopStandInCrew, type StandInCrew } from "./helpers/crew-standin.ts";

/** The error `runStep` returns when the watch stops a check for CPU. */
const STOP = `check stopped: it ${cpuBreach(16.3, 31, 16, { pid: 52062, ticks: 46_200, name: "sh" })}`;

describe("a pull's check stopped for CPU, through the service", () => {
  let standIn: StandInCrew;
  let app: App;
  let alice: User;
  let bot: User;
  /** Each stop the stand-in step made, in order. */
  const stops: string[] = [];
  /** The second stop waits for this, so the first is seen alone. */
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  /** Whether the service announced a red check while only the first stop had happened. */
  let redBeforeSecond = false;

  // The pull's checkout holds CREW.md (the stand-in agent's work); main's does not and passes.
  // The pull's first two checks are stopped for CPU; any later one passes.
  const checkStep: typeof runStep = async (_name, command, options) => {
    options.log(`$ ${command}`);
    if (!existsSync(join(options.cwd, "CREW.md")) || stops.length >= 2) return ok();
    if (stops.length === 1) await released;
    stops.push(STOP);
    options.log(STOP);
    return err(STOP);
  };

  beforeAll(async () => {
    standIn = await startStandInCrew({ tickMs: 50, checkStep });
    ({ app, alice, bot } = standIn);
    app.bus.subscribe((e) => {
      if (e.kind === "run.finished" && (e.payload as { kind?: unknown; state?: unknown }).kind === "check"
        && (e.payload as { state?: unknown }).state === "failed" && stops.length < 2) redBeforeSecond = true;
    });
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

  test("the first stop is queued again with no check_failed; the second is red and sends one", async () => {
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
    const reworks = () => listRuns(app.db, kiln.id, { kind: "agent", limit: 50 }).filter((r) => r.reason === "check_failed");

    // The first stop: cancelled as the machine's, and its retry queued for the same head.
    const first = await until(() => pullChecks().find((r) => r.attempt === 0 && r.state === "cancelled"));
    expect(first.summary).toBe(CPU_STOP_SUMMARY);
    const retry = await until(() => pullChecks().find((r) => r.attempt === 1));
    expect(retry.commitOid).toBe(first.commitOid);
    expect(stops).toHaveLength(1);
    // The builder hears nothing of it: give dispatch time to answer an event, were there one.
    await Bun.sleep(500);
    expect(reworks()).toHaveLength(0);
    expect(redBeforeSecond).toBe(false);

    // The second stop in a row is reported red, and the builder is sent check_failed.
    release();
    const red = await until(() => pullChecks().find((r) => r.attempt === 1 && r.state === "failed"));
    expect(red.summary).toContain("used 16.3 cores for 31s, over its limit of 16");
    expect(stops).toHaveLength(2);
    await until(() => (reworks().length > 0 ? true : undefined));
    expect(reworks()).toHaveLength(1);
    // Never a third attempt of that head: the second stop was not queued again.
    expect(pullChecks().filter((r) => r.commitOid === first.commitOid).map((r) => r.attempt).sort()).toEqual([0, 1]);
  }, 30_000);
});
