/**
 * A check stopped for CPU (#11617): the cell's watch line reads as the
 * machine's failure, the first stop of a head is queued again once on its own
 * (cancelled, never red, so no builder hears check_failed), the second is
 * reported, and /flow names the stops when they are the hour's main failure.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { cpuBreach, stoppedForCpu } from "../src/apps/contain.ts";
import { requeueCpuStop } from "../src/checks/cpu_stop.ts";
import type { Repo } from "../src/core/repos.ts";
import { claimRun, CPU_STOP_SUMMARY, createRun, finishRun, getRun, listRuns } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";
import { cpuStopReason, cpuStops } from "../src/flow/cpu_stops.ts";
import { readClogView } from "../src/flow/clog_view.ts";

/** The error `runStep` returns when the watch stops a check for CPU, from the watch's own words. */
const STOP = `check stopped: it ${cpuBreach(16.3, 31, 16, { pid: 52062, ticks: 46_200, name: "sh" })}`;

describe("stoppedForCpu", () => {
  test("reads runStep's CPU stop, and nothing a check could print", () => {
    expect(STOP).toBe("check stopped: it used 16.3 cores for 31s, over twice its limit of 16; the busiest process is sh (pid 52062, 462s of CPU)");
    expect(stoppedForCpu(STOP)).toBe(true);
    expect(stoppedForCpu(`check stopped: it ${cpuBreach(3, 300, 2, undefined)}`)).toBe(true);
    // The check's own output follows "exited with code": it cannot pose as the watch.
    expect(stoppedForCpu("check exited with code 1 — stopped: used 16.3 cores for 31s, over its limit of 16")).toBe(false);
    expect(stoppedForCpu("check stopped: it used 900 MiB of memory, over its 512 MiB limit (default)")).toBe(false);
    expect(stoppedForCpu("check took longer than 600s")).toBe(false);
  });
});

describe("a check stopped for CPU", () => {
  let dataDir: string;
  let app: App;
  let repo: Repo;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-cpu-stop-"));
    app = createApp({ dataDir, port: 0 });
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    const made = await createRepo(app, a.value, { name: "engine", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
  });
  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("is queued again once, not red; a second stop is reported", () => {
    const first = createRun(app.db, { repoId: repo.id, kind: "check", env: "pull-7", commitOid: "a".repeat(40), reason: "push" });
    const running = claimRun(app.db, first.id)!;
    const moved = requeueCpuStop(app.db, running, STOP)!;
    expect(moved).toBeDefined();
    // Cancelled, not failed: nothing announces a red, so no check_failed is queued for it.
    expect(getRun(app.db, first.id)!.state).toBe("cancelled");
    expect(getRun(app.db, first.id)!.summary).toBe(CPU_STOP_SUMMARY);
    expect(moved.again.state).toBe("queued");
    expect(moved.again.attempt).toBe(1);
    expect(moved.again.commitOid).toBe("a".repeat(40));
    expect(moved.again.env).toBe("pull-7");

    const second = claimRun(app.db, moved.again.id)!;
    expect(requeueCpuStop(app.db, second, STOP)).toBeUndefined();
    expect(getRun(app.db, second.id)!.state).toBe("running");
    finishRun(app.db, second.id, { state: "failed", summary: `check failed: ${STOP.replace("check stopped: it ", "stopped: ")}` });
    const runs = listRuns(app.db, repo.id, { kind: "check" });
    expect(runs.map((r) => r.state).sort()).toEqual(["cancelled", "failed"]);
  });

  test("a red that is not a CPU stop is not queued again", () => {
    const run = createRun(app.db, { repoId: repo.id, kind: "check", env: "pull-8", commitOid: "b".repeat(40), reason: "push" });
    const running = claimRun(app.db, run.id)!;
    expect(requeueCpuStop(app.db, running, "check exited with code 1 — 2 tests failed")).toBeUndefined();
    expect(getRun(app.db, run.id)!.state).toBe("running");
    finishRun(app.db, run.id, { state: "failed", summary: "check failed: 2 tests failed" });
  });

  test("/flow names CPU stops when they are the hour's main failure", () => {
    // The hour so far: the queued-again stop, the reported stop, one ordinary red.
    expect(cpuStops(app.db)).toEqual({ stopped: 2, failed: 3 });
    expect(cpuStopReason(cpuStops(app.db))).toBe("checks stopped for CPU: 2 of 3 failed checks in the last hour");
    // An hour later they have left the window.
    expect(cpuStops(app.db, new Date(Date.now() + 3_700_000))).toEqual({ stopped: 0, failed: 0 });
    expect(cpuStopReason({ stopped: 1, failed: 3 })).toBeUndefined();
    expect(cpuStopReason({ stopped: 0, failed: 0 })).toBeUndefined();
    expect(cpuStopReason({ stopped: 1, failed: 1 })).toBe("checks stopped for CPU: 1 of 1 failed check in the last hour");
  });

  test("/flow's sentence leads with the CPU stops, and is said when they are the only clog", () => {
    // Nothing else clogs this forge: no shared red, no pairs, no standing clog, no conflicts.
    const view = readClogView(app.db);
    expect(view.says.startsWith("Clogged: checks stopped for CPU: 2 of 3 failed checks in the last hour")).toBe(true);
    expect(view.shared).toEqual([]);
    expect(view.pairs).toEqual([]);
    // An hour later the stops have left the window, and the sentence with them.
    expect(readClogView(app.db, new Date(Date.now() + 3_700_000)).says).not.toContain("stopped for CPU");
  });

  test("the hour's checks are read from run_kind_finished, not a scan", () => {
    const db = app.db;
    const original = db.query.bind(db);
    const sqls: string[] = [];
    (db as unknown as { query: unknown }).query = (sql: string) => {
      sqls.push(sql);
      return original(sql);
    };
    try {
      cpuStops(db);
    } finally {
      (db as unknown as { query: unknown }).query = original;
    }
    expect(sqls.length).toBe(1);
    const plan = original(`EXPLAIN QUERY PLAN ${sqls[0]!}`)
      .all("x")
      .map((r) => (r as { detail: string }).detail)
      .join("\n");
    expect(plan).toContain("run_kind_finished");
    expect(plan).not.toMatch(/^SCAN (?!.*USING (COVERING )?INDEX)/m);
    expect(plan).not.toContain("TEMP B-TREE");
  });
});
