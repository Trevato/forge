/**
 * A red recorded while the check machine's disk was under its free floor is
 * the machine's (#5453): not reworked, not parked, checked again when the
 * disk is back above the floor, and one vitals card for all of them. The
 * disk reading is plain data, injected.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { App } from "../src/app.ts";
import { announceRun } from "../src/actions/runs.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { openPull } from "../src/actions/pulls.ts";
import { diskReading, withDisk } from "../src/checks/disk_red.ts";
import { CHECK_FAILED_LIMIT, recheckForDisk } from "../src/crew/dispatch.ts";
import { getIssueById } from "../src/core/issues.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun, type Run } from "../src/core/runs.ts";
import type { User } from "../src/core/users.ts";
import { statDisk, vitals } from "../src/kernel/vitals.ts";
import { ErrorLedger } from "../src/kernel/log.ts";
import { RefusedLedger } from "../src/kernel/internal_refused.ts";
import { startStandInCrew, stopStandInCrew, type StandInCrew } from "./helpers/crew-standin.ts";

describe("a red on a full check machine", () => {
  let standIn: StandInCrew;
  let app: App;
  let alice: User;
  let bot: User;
  let repo: Repo;
  let requested: unknown[][] = [];
  let n = 0;
  const reading = (permille: number) => () => ({ freeBytes: permille, totalBytes: 1000 });

  beforeAll(async () => {
    standIn = await startStandInCrew();
    ({ app, alice, bot, repo } = standIn);
    standIn.checks.request = async (...args: unknown[]) => {
      requested.push(args);
      return undefined;
    };
    app.db.run("UPDATE repo SET autonomy = 'autonomous', autonomy_by = ?1 WHERE id = ?2", [alice.id, repo.id]);
  }, 30_000);
  afterAll(() => {
    diskReading.read = statDisk;
    return stopStandInCrew(standIn);
  });

  const spentPull = async (): Promise<Pull> => {
    const branch = `disk-${++n}`;
    const c = await commitToBranch(app, alice, repo, {
      message: branch,
      branch,
      files: [{ path: `${branch}.md`, content: "x\n" }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    const o = await openPull(app, bot, repo, { title: branch, baseBranch: "main", headBranch: branch });
    if (!o.ok) throw new Error(String(o.error));
    app.db.run("UPDATE issue SET assignee_id = ?1 WHERE id = ?2", [bot.id, o.value.id]);
    for (let i = 0; i < CHECK_FAILED_LIMIT; i++) {
      const tried = createRun(app.db, { repoId: repo.id, kind: "agent", issueId: o.value.id, reason: "check_failed" });
      claimRun(app.db, tried.id);
      finishRun(app.db, tried.id, { state: "ok", summary: "reworked" });
    }
    return getPull(app.db, repo.id, o.value.number)!;
  };
  /** A red check, its detail recorded the way the service does, under a given disk. */
  const failed = (pull: Pull, free: number): Run => {
    diskReading.read = reading(free);
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
      reason: "push",
      issueId: pull.id,
    });
    claimRun(app.db, run.id);
    return finishRun(app.db, run.id, {
      state: "failed",
      summary: "check failed",
      checkDetail: withDisk({ passed: 1, failed: 1, names: [`T${n}`] }, app.config.dataDir),
    })!;
  };
  const open = (pull: Pull) => getIssueById(app.db, pull.id)?.state === "open";
  const cards = (freeNow = 30) =>
    vitals({
      db: app.db,
      dataDir: app.config.dataDir,
      disk: reading(freeNow),
      signals: { errors: new ErrorLedger(), refused: new RefusedLedger() },
    }).degraded.filter((d) => d.cause === "disk-red");

  test("the service records the free share on a red, even one that named no test", () => {
    diskReading.read = reading(30);
    expect(withDisk(undefined, "/").diskFree).toBeCloseTo(0.03);
    expect(withDisk({ passed: 1, failed: 1, names: ["X"] }, "/")).toEqual({ passed: 1, failed: 1, names: ["X"], diskFree: 0.03 });
  });

  test("under the floor: not parked, not reworked, re-run once the disk recovers; one card", async () => {
    const pulls = [await spentPull(), await spentPull(), await spentPull()];
    for (const p of pulls) announceRun(app, failed(p, 40));
    for (const p of pulls) expect(open(p)).toBe(true);

    const found = cards();
    expect(found).toHaveLength(1);
    expect(found[0]!.sentence).toContain("when 3 checks failed");
    expect(found[0]!.sentence).toContain("4% free");

    requested = [];
    diskReading.read = reading(50);
    recheckForDisk(app);
    expect(requested).toHaveLength(0);
    diskReading.read = reading(300);
    recheckForDisk(app);
    expect(requested.map((r) => r[4]).sort()).toEqual(pulls.map((p) => p.id).sort());
    recheckForDisk(app);
    expect(requested).toHaveLength(3);
  });

  test("another forge's recheck leaves this forge's waiting pulls alone", async () => {
    const other = await startStandInCrew();
    try {
      const asked: unknown[][] = [];
      other.checks.request = async (...args: unknown[]) => {
        asked.push(args);
        return undefined;
      };
      const pull = await spentPull();
      requested = [];
      announceRun(app, failed(pull, 40));
      diskReading.read = reading(300);
      recheckForDisk(other.app);
      expect(requested).toHaveLength(0);
      expect(asked).toHaveLength(0);
      recheckForDisk(app);
      expect(requested.map((r) => r[4])).toEqual([pull.id]);
    } finally {
      await stopStandInCrew(other);
    }
  }, 30_000);

  test("the card ends when the disk is back above the floor, not an hour later", () => {
    expect(cards(30)).toHaveLength(1);
    expect(cards(500)).toHaveLength(0);
  });

  test("above the floor: a red is the pull's own, parked as ever, and no card", async () => {
    const before = cards()[0]!.sentence;
    const own = await spentPull();
    announceRun(app, failed(own, 300));
    expect(open(own)).toBe(false);
    expect(cards()[0]!.sentence).toBe(before);
  });
});

describe("a full check machine gives back unused checkouts", () => {
  test("under the floor the sweep removes a checkout no run owns; above it, nothing", async () => {
    const { mkdirSync, existsSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { reclaimIfFull } = await import("../src/checks/service.ts");
    const standIn = await startStandInCrew();
    const dataDir = join(process.env.TMPDIR ?? "/tmp", `reclaim-${Date.now()}`);
    try {
      const app = { ...standIn.app, config: { ...standIn.app.config, dataDir } } as App;
      const orphan = join(dataDir, "checks", "orphan");
      mkdirSync(orphan, { recursive: true });
      diskReading.read = () => ({ freeBytes: 500, totalBytes: 1000 });
      expect(await reclaimIfFull(app)).toBe(false);
      expect(existsSync(orphan)).toBe(true);
      diskReading.read = () => ({ freeBytes: 50, totalBytes: 1000 });
      expect(await reclaimIfFull(app)).toBe(true);
      expect(existsSync(orphan)).toBe(false);
    } finally {
      diskReading.read = statDisk;
      rmSync(dataDir, { recursive: true, force: true });
      await stopStandInCrew(standIn);
    }
  }, 30_000);
});
