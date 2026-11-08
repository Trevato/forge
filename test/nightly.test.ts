import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { listPulls } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { refTip } from "../src/git/read.ts";
import { proposeQuarantine } from "../src/nightly/propose.ts";
import { startNightly } from "../src/nightly/service.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HUNT_SLICES, JOBS } from "../src/nightly/jobs.ts";
import { nightlyLine } from "../src/nightly/says.ts";
import { lastSlot, owed, untilNext } from "../src/nightly/slots.ts";
import { readLast, writeLast } from "../src/nightly/stamps.ts";

quietLogs();

const slot = { hour: 2, minute: 17 };
const at = (iso: string): number => Date.parse(iso);

describe("nightly slots", () => {
  test("the latest slot is today's once it has passed, yesterday's before", () => {
    expect(lastSlot(slot, at("2026-11-02T03:00:00Z"))).toBe(at("2026-11-02T02:17:00Z"));
    expect(lastSlot(slot, at("2026-11-02T01:00:00Z"))).toBe(at("2026-11-01T02:17:00Z"));
  });

  test("the wait to the next slot is positive and under a day", () => {
    expect(untilNext(slot, at("2026-11-02T02:17:00Z"))).toBe(86_400_000);
    expect(untilNext(slot, at("2026-11-02T02:16:00Z"))).toBe(60_000);
  });

  test("a run is owed when the last began before the latest slot, never for a forge that has none", () => {
    const now = at("2026-11-02T03:00:00Z");
    expect(owed(slot, at("2026-11-01T02:20:00Z"), now)).toBe(true);
    expect(owed(slot, at("2026-11-02T02:20:00Z"), now)).toBe(false);
    expect(owed(slot, undefined, now)).toBe(false);
  });
});

describe("nightly records", () => {
  test("a record reads back, and a missing or broken one reads as none", () => {
    const dir = mkdtempSync(join(tmpdir(), "nightly-"));
    try {
      expect(readLast(dir, "outside-gate")).toBeUndefined();
      const last = { slot: at("2026-11-02T03:47:00Z"), startedAt: at("2026-11-02T09:00:00Z"), says: "ok." };
      writeLast(dir, "outside-gate", last);
      expect(readLast(dir, "outside-gate")).toEqual(last);
      writeFileSync(join(dir, "nightly", "outside-gate.json"), "{nope");
      expect(readLast(dir, "outside-gate")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a line says never run, not finished, and what a run said", () => {
    const s = { hour: 3, minute: 47 };
    expect(nightlyLine("x", s, undefined)).toContain("has not run yet; its slot is 03:47 UTC");
    expect(nightlyLine("x", s, { slot: 1, startedAt: at("2026-11-02T03:47:00Z"), says: "began" })).toContain("has not finished");
    const done = { slot: 1, startedAt: at("2026-11-02T03:47:00Z"), finishedAt: at("2026-11-02T04:10:00Z"), says: "every step finished." };
    expect(nightlyLine("x", s, done)).toBe("x: 2026-11-02 03:47 UTC to 2026-11-02 04:10 UTC, every step finished.");
  });
});

describe("nightly jobs", () => {
  test("the hunt covers every slice once and ends in the quarantine; the outside run is one step", () => {
    const hunt = JOBS.find((j) => j.name === "flake-hunt")!;
    const slices = hunt.steps.filter((s) => s.label.startsWith("hunt slice"));
    expect(slices).toHaveLength(HUNT_SLICES);
    expect(new Set(slices.map((s) => s.command)).size).toBe(HUNT_SLICES);
    expect(hunt.steps.at(-1)?.label).toBe("quarantine");
    expect(JOBS.find((j) => j.name === "outside-gate")!.steps.map((s) => s.label)).toEqual([
      "install",
      "run the excluded files",
    ]);
  });

  test("only the steps that file hold the token, and every script a step runs exists", () => {
    for (const job of JOBS)
      for (const step of job.steps) {
        expect(step.reports).toBe(step.command.includes("flake-hunt.ts"));
        const script = /scripts\/[\w-]+\.ts/.exec(step.command)?.[0];
        if (script !== undefined) expect(existsSync(join(import.meta.dir, "..", script))).toBe(true);
      }
  });
});

describe("the nightly service", () => {
  let dir: string;
  let app: App;
  const calls: string[] = [];
  let release: (() => void) | undefined;
  const instant = {
    run: async (job: { name: string }) => {
      calls.push(job.name);
      return { dir: "x", oid: "y", failed: [] as string[], filed: [] as string[] };
    },
    propose: async () => undefined,
  };
  const SLOT_AFTER = at("2026-11-02T03:00:00Z");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nightly-svc-"));
    app = createApp({ dataDir: dir, port: 0 });
    calls.length = 0;
    delete process.env["FORGE_APP_ENV"];
    delete process.env["FORGE_CREW_IN_PREVIEW"];
  });
  afterEach(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env["FORGE_APP_ENV"];
  });

  test("it is off without a token", () => {
    expect(startNightly(app, { forgeUrl: "http://f", token: undefined, doing: instant })).toBeUndefined();
    expect(startNightly(app, { forgeUrl: "http://f", token: "", doing: instant })).toBeUndefined();
  });

  test("it is off in a preview", () => {
    process.env["FORGE_APP_ENV"] = "preview";
    expect(startNightly(app, { forgeUrl: "http://f", token: "t", doing: instant })).toBeUndefined();
  });

  test("a job whose slot passed while the forge was down runs once on waking, and keeps that slot", async () => {
    const yesterday = { slot: at("2026-11-01T02:17:00Z"), startedAt: at("2026-11-01T02:17:00Z"), finishedAt: at("2026-11-01T05:00:00Z"), says: "ok." };
    writeLast(dir, "flake-hunt", yesterday);
    writeLast(dir, "outside-gate", { ...yesterday, slot: at("2026-11-01T03:47:00Z") });
    const handle = startNightly(app, { forgeUrl: "http://f", token: "t", doing: instant, now: () => SLOT_AFTER })!;
    while (readLast(dir, "flake-hunt")?.slot !== at("2026-11-02T02:17:00Z") || calls.length === 0) await Bun.sleep(5);
    await handle.stop();
    // Only the hunt's slot (02:17) has passed since; the outside run's (03:47) has not.
    expect(calls).toEqual(["flake-hunt"]);
    expect(readLast(dir, "flake-hunt")?.slot).toBe(at("2026-11-02T02:17:00Z"));
    expect(readLast(dir, "flake-hunt")?.finishedAt).toBeDefined();
  });

  test("a forge that never ran a job owes none, and a job already kept is not run again", async () => {
    const fresh = startNightly(app, { forgeUrl: "http://f", token: "t", doing: instant, now: () => SLOT_AFTER })!;
    await fresh.stop();
    expect(calls).toEqual([]);
    writeLast(dir, "flake-hunt", { slot: at("2026-11-02T02:17:00Z"), startedAt: at("2026-11-02T02:17:30Z"), says: "began" });
    const again = startNightly(app, { forgeUrl: "http://f", token: "t", doing: instant, now: () => SLOT_AFTER })!;
    await again.stop();
    expect(calls).toEqual([]);
  });

  test("a job queued behind another records its own slot, not the time it got to start", async () => {
    const handle = startNightly(app, { forgeUrl: "http://f", token: "t", doing: instant, now: () => at("2026-11-02T03:50:00Z") })!;
    await handle.run("flake-hunt");
    await handle.run("outside-gate");
    await handle.stop();
    expect(readLast(dir, "outside-gate")?.slot).toBe(at("2026-11-02T03:47:00Z"));
  });

  test("stop aborts a run in flight at once and the record says it was stopped", async () => {
    let seen: AbortSignal | undefined;
    const slow = {
      run: (_job: unknown, signal: AbortSignal) => {
        seen = signal;
        return new Promise<{ dir: string; oid: string; failed: string[]; filed: string[] }>((resolve) => {
          signal.addEventListener("abort", () => resolve({ dir: "x", oid: "y", failed: ["hunt slice 3/20"], filed: [] }));
          release = () => resolve({ dir: "x", oid: "y", failed: [], filed: [] });
        });
      },
      propose: async () => undefined,
    };
    const handle = startNightly(app, { forgeUrl: "http://f", token: "t", doing: slow, now: () => SLOT_AFTER })!;
    const running = handle.run("outside-gate");
    await Bun.sleep(10);
    expect(seen?.aborted).toBe(false);
    await handle.stop();
    await running;
    expect(seen?.aborted).toBe(true);
    release?.();
    expect(readLast(dir, "outside-gate")?.says).toContain("stopped by a restart");
  });

  test("a run that could not start says why, and files no pull", async () => {
    let proposed = 0;
    const handle = startNightly(app, {
      forgeUrl: "http://f",
      token: "t",
      now: () => SLOT_AFTER,
      doing: { run: async () => ({ error: "no cell to run it in" }), propose: async () => void proposed++ as undefined },
    })!;
    await handle.run("flake-hunt");
    await handle.stop();
    expect(readLast(dir, "flake-hunt")?.says).toBe("not run: no cell to run it in.");
    expect(proposed).toBe(0);
  });

  test("the hunt proposes after its steps, unless the quarantine itself failed; the outside run never does", async () => {
    let proposed = 0;
    const doing = (failed: string[]) => ({
      run: async () => ({ dir: "x", oid: "y", failed, filed: [] }),
      propose: async () => {
        proposed++;
        return "flake-hunt/2026-11-02";
      },
    });
    const green = startNightly(app, { forgeUrl: "http://f", token: "t", now: () => SLOT_AFTER, doing: doing([]) })!;
    await green.run("flake-hunt");
    await green.run("outside-gate");
    await green.stop();
    expect(proposed).toBe(1);
    expect(readLast(dir, "flake-hunt")?.says).toContain("quarantine pull on flake-hunt/2026-11-02");
    const red = startNightly(app, { forgeUrl: "http://f", token: "t", now: () => SLOT_AFTER, doing: doing(["quarantine"]) })!;
    await red.run("flake-hunt");
    await red.stop();
    expect(proposed).toBe(1);
  });
});

describe("the quarantine pull", () => {
  let dir: string;
  let work: string;
  let app: App;
  let repo: Repo;
  let oid: string;
  const ORIGINAL = "export const EXCLUDED = {};\n";

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "nightly-pull-"));
    work = mkdtempSync(join(tmpdir(), "nightly-work-"));
    app = createApp({ dataDir: dir, port: 0 });
    const owner = await seedAdmin(app, { username: "alice", email: "alice@forge.test", password: "a-long-passphrase" });
    if (!owner.ok) throw new Error("no owner");
    const made = await createRepo(app, owner.value, { name: "forge", visibility: "public" });
    if (!made.ok) throw new Error("no repo");
    repo = made.value;
    const seeded = await commitToBranch(app, owner.value, repo, { message: "seed", files: [{ path: "scripts/gate.ts", content: ORIGINAL }] });
    if (!seeded.ok) throw new Error("no seed");
    oid = (await refTip(join(app.reposRoot, "alice", "forge.git"), `refs/heads/${repo.defaultBranch}`))!;
    mkdirSync(join(work, "scripts"), { recursive: true });
  });
  afterAll(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  test("a file the job left unchanged proposes nothing", async () => {
    writeFileSync(join(work, "scripts/gate.ts"), ORIGINAL);
    const branch = await proposeQuarantine(app, repo, { dir: work, oid }, "scripts/gate.ts", "flake-hunt", at("2026-11-02T03:00:00Z"));
    expect(branch).toBeUndefined();
    expect(listPulls(app.db, repo.id, {})).toHaveLength(0);
  });

  test("a file the job edited is proposed as one pull on a dated branch", async () => {
    writeFileSync(join(work, "scripts/gate.ts"), "export const EXCLUDED = { a: 1 };\n");
    const branch = await proposeQuarantine(app, repo, { dir: work, oid }, "scripts/gate.ts", "flake-hunt", at("2026-11-02T03:00:00Z"));
    expect(branch).toBe("flake-hunt/2026-11-02");
    const pulls = listPulls(app.db, repo.id, {});
    expect(pulls).toHaveLength(1);
    expect(pulls[0]?.title).toBe("Quarantine flaky tests (flake-hunt/2026-11-02)");
  });
});
