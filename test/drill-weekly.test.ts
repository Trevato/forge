/**
 * The weekly drill runs on its own: owed once per Sunday slot, kept after,
 * and a count that differs from the snapshot's is red and a line.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { vitals } from "../src/kernel/vitals.ts";
import { runDrill, type DrillResult } from "../src/snapshot/drill.ts";
import { BOOT_RED_FLOOR_MS, drillDue, lastSlot, RED_RETRY_MS } from "../src/snapshot/due.ts";
import { lastDrill, recordDrill } from "../src/snapshot/drills.ts";
import { startSnapshots } from "../src/snapshot/service.ts";
import { takeSnapshot } from "../src/snapshot/snapshot.ts";
import { dirStore } from "../src/snapshot/store.ts";
import { recordVerdict } from "../src/snapshot/verdict.ts";

const t = (iso: string): number => Date.parse(iso);
const green = (at: string) => ({ at, verdict: "green" as const });
const red = (at: string) => ({ at, verdict: "red" as const });

describe("when a weekly drill is owed", () => {
  // 2026-10-11 is a Sunday.
  test("the slot is the latest Sunday 09:00 UTC", () => {
    expect(new Date(lastSlot(t("2026-10-16T12:00:00Z"))).toISOString()).toBe("2026-10-11T09:00:00.000Z");
    expect(new Date(lastSlot(t("2026-10-11T08:59:00Z"))).toISOString()).toBe("2026-10-04T09:00:00.000Z");
  });

  test("owed once: a drill since the slot keeps it, an older one does not", () => {
    const now = t("2026-10-11T09:30:00Z");
    expect(drillDue(green("2026-10-04T09:05:00.000Z"), undefined, now)).toBe(true);
    expect(drillDue(green("2026-10-11T09:05:00.000Z"), undefined, now)).toBe(false);
    // a restart later the same day finds it kept
    expect(drillDue(green("2026-10-11T09:05:00.000Z"), undefined, t("2026-10-11T20:00:00Z"))).toBe(false);
  });

  test("a red drill is owed again after RED_RETRY_MS, and on a boot past the floor", () => {
    // #2541: red at 09:11, the fix deployed at 10:18; the card stood for the week.
    const at = "2026-10-18T09:11:45.853Z";
    expect(drillDue(red(at), undefined, t(at) + 60_000)).toBe(false);
    expect(drillDue(red(at), undefined, t(at) + RED_RETRY_MS - 1)).toBe(false);
    expect(drillDue(red(at), undefined, t(at) + RED_RETRY_MS)).toBe(true);
    expect(drillDue(red(at), undefined, t("2026-10-18T10:23:00Z"), BOOT_RED_FLOOR_MS)).toBe(true);
    // a boot soon after the red one (a crash loop) does not restore again
    expect(drillDue(red(at), undefined, t(at) + BOOT_RED_FLOOR_MS - 1, BOOT_RED_FLOOR_MS)).toBe(false);
    // a green one keeps its slot on a boot too
    expect(drillDue(green(at), undefined, t("2026-10-18T10:23:00Z"), 0)).toBe(false);
  });

  test("a forge with no drill owes one only if it is older than the slot", () => {
    const now = t("2026-10-11T09:30:00Z");
    expect(drillDue(undefined, "2026-10-01T00:00:00Z", now)).toBe(true);
    expect(drillDue(undefined, "2026-10-11T09:10:00Z", now)).toBe(false);
    expect(drillDue(undefined, undefined, now)).toBe(false);
  });
});

describe("the service runs a due drill once", () => {
  test("a second look after the drill was kept runs nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-drill-once-"));
    const app = createApp({ dataDir: root, port: 0 });
    let ran = 0;
    const svc = startSnapshots(app, dirStore(join(root, "store")), {
      version: "t",
      nightly: false,
      drill: async (): Promise<DrillResult> => {
        ran++;
        return {
          at: new Date().toISOString(),
          snapshotId: "s",
          ms: 1,
          counts: { repositories: 0, issues: 0, users: 0, pulls: 0, apps: 0 },
          health: "ok",
          verdict: "green",
          failedStep: null,
          reason: null,
        };
      },
    });
    try {
      // The forge has been here since long before the latest slot.
      mkdirSync(join(root, "drill"), { recursive: true });
      writeFileSync(join(root, "drill", "first-seen"), new Date(Date.now() - 30 * 86_400_000).toISOString());
      expect(await svc.drillIfDue()).toBe(true);
      expect(await svc.drillIfDue()).toBe(false);
      expect(ran).toBe(1);
      expect(lastDrill(app.db)?.verdict).toBe("green");
    } finally {
      await svc.stop();
      app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a red drill that has stood RED_RETRY_MS is run again until one passes", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-drill-red-"));
    const app = createApp({ dataDir: root, port: 0 });
    const verdicts: DrillResult["verdict"][] = [];
    const svc = startSnapshots(app, dirStore(join(root, "store")), {
      version: "t",
      nightly: false,
      drill: async (): Promise<DrillResult> => {
        const verdict = verdicts.length === 0 ? "red" : "green";
        verdicts.push(verdict);
        return {
          // The red one ran long enough ago to be owed again.
          at: new Date(Date.now() - (verdict === "red" ? RED_RETRY_MS : 0)).toISOString(),
          snapshotId: "s",
          ms: 1,
          counts: { repositories: 0, issues: 0, users: 0, pulls: 0, apps: 0 },
          health: verdict === "red" ? "unreached" : "ok",
          verdict,
          failedStep: verdict === "red" ? "restore" : null,
          reason: verdict === "red" ? "restore timed out: no answer in 600000 ms" : null,
        };
      },
    });
    try {
      mkdirSync(join(root, "drill"), { recursive: true });
      writeFileSync(join(root, "drill", "first-seen"), new Date(Date.now() - 30 * 86_400_000).toISOString());
      expect(await svc.drillIfDue()).toBe(true);
      expect(lastDrill(app.db)?.verdict).toBe("red");
      expect(await svc.drillIfDue()).toBe(true);
      expect(lastDrill(app.db)?.verdict).toBe("green");
      expect(await svc.drillIfDue()).toBe(false);
      expect(verdicts).toEqual(["red", "green"]);
    } finally {
      await svc.stop();
      app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("the service's own clock drills a red one again", () => {
  const result = (verdict: DrillResult["verdict"]): DrillResult => ({
    at: new Date().toISOString(),
    snapshotId: "s",
    ms: 1,
    counts: { repositories: 0, issues: 0, users: 0, pulls: 0, apps: 0 },
    health: verdict === "red" ? "unreached" : "ok",
    verdict,
    failedStep: verdict === "red" ? "restore" : null,
    reason: verdict === "red" ? "restore timed out: no answer in 600000 ms" : null,
  });

  /**
   * A forge booted with nightly on and short delays, its newest drill
   * `before` (kept before boot), each drill it runs answering the next of
   * `answers`; and the time it was booted, for the waits.
   */
  async function boot(
    before: DrillResult["verdict"] | undefined,
    answers: DrillResult["verdict"][],
    opts: { bootRedFloorMs?: number } = {},
  ) {
    const root = mkdtempSync(join(tmpdir(), "forge-drill-clock-"));
    mkdirSync(join(root, "drill"), { recursive: true });
    writeFileSync(join(root, "drill", "first-seen"), new Date(Date.now() - 30 * 86_400_000).toISOString());
    const app = createApp({ dataDir: root, port: 0 });
    if (before !== undefined) recordDrill(app.db, result(before));
    const ran: DrillResult["verdict"][] = [];
    const svc = startSnapshots(app, dirStore(join(root, "store")), {
      version: "t",
      mirrorEveryMs: 3_600_000,
      catchUpMs: 20,
      redRetryMs: 60,
      bootRedFloorMs: opts.bootRedFloorMs ?? 0,
      drill: async () => {
        const verdict = answers[ran.length] ?? "green";
        ran.push(verdict);
        return result(verdict);
      },
    });
    const done = async () => {
      await svc.stop();
      app.close();
      await rm(root, { recursive: true, force: true });
    };
    return { app, svc, ran, done };
  }

  test("the boot catch-up drills a red one at once", async () => {
    const f = await boot("red", ["green"]);
    try {
      await Bun.sleep(150);
      expect(f.ran).toEqual(["green"]);
      expect(lastDrill(f.app.db)?.verdict).toBe("green");
    } finally {
      await f.done();
    }
  });

  test("the boot catch-up leaves a green one of this week alone", async () => {
    const f = await boot("green", []);
    try {
      await Bun.sleep(150);
      expect(f.ran).toEqual([]);
    } finally {
      await f.done();
    }
  });

  test("a boot inside the floor does not restore again, and the retry still comes", async () => {
    const f = await boot("red", ["green"], { bootRedFloorMs: 3_600_000 });
    try {
      await Bun.sleep(40);
      expect(f.ran).toEqual([]);
      await Bun.sleep(150);
      expect(f.ran).toEqual(["green"]);
    } finally {
      await f.done();
    }
  });

  test("a red result arms the retry, which drills again and stops after a pass", async () => {
    const f = await boot(undefined, ["red", "red", "green"]);
    try {
      await Bun.sleep(400);
      expect(f.ran).toEqual(["red", "red", "green"]);
      await Bun.sleep(200);
      expect(f.ran).toEqual(["red", "red", "green"]);
    } finally {
      await f.done();
    }
  });

  test("stop clears the retry", async () => {
    const f = await boot(undefined, ["red"]);
    try {
      await Bun.sleep(40);
      expect(f.ran).toEqual(["red"]);
      await f.svc.stop();
      await Bun.sleep(200);
      expect(f.ran).toEqual(["red"]);
    } finally {
      await f.done();
    }
  });
});

describe("a count that differs is red", () => {
  let root: string;
  let app: App;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "forge-drill-weekly-"));
    app = createApp({ dataDir: join(root, "live"), port: 0 });
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
    const r = await createRepo(app, u.value, { name: "one", visibility: "private" });
    if (!r.ok) throw new Error(String(r.error));
  });

  afterAll(async () => {
    app.close();
    await rm(root, { recursive: true, force: true });
  });

  const snapshot = (name: string, at: string) =>
    takeSnapshot(
      { db: app.db, dataDir: app.config.dataDir, reposRoot: app.reposRoot, version: "t" },
      dirStore(join(root, name)),
      new Date(at),
    );
  const drill = (name: string) =>
    runDrill({
      store: dirStore(join(root, name)),
      dataDir: join(root, "scratch"),
      boot: async () => ({ ok: true, reason: "" }),
    });

  test("the manifest keeps the counts and a matching restore is green, scratch removed", async () => {
    const m = await snapshot("good", "2026-10-10T08:00:00Z");
    expect(m.counts).toMatchObject({ users: 1, repositories: 1 });
    const r = await drill("good");
    expect(r.verdict).toBe("green");
    expect(readdirSync(join(root, "scratch", "drill"))).toEqual([]);
  });

  test("a manifest that disagrees with the restore is red at count, names the count, and raises the line", async () => {
    await snapshot("bad", "2026-10-10T09:00:00Z");
    const path = join(root, "bad", "snapshots", "2026-10-10T09-00-00Z", "manifest.json");
    expect(existsSync(path)).toBe(true);
    const manifest = JSON.parse(await Bun.file(path).text());
    manifest.counts.users = 7;
    await Bun.write(path, JSON.stringify(manifest));

    const r = await drill("bad");
    expect(r.verdict).toBe("red");
    expect(r.failedStep).toBe("count");
    expect(r.reason).toContain("users 7 became 1");

    recordDrill(app.db, r);
    recordVerdict(app.config.dataDir, r);
    expect(lastDrill(app.db)?.verdict).toBe("red");
    const lines = vitals({
      db: app.db,
      dataDir: app.config.dataDir,
      signals: app.signals,
      now: Date.parse(r.at) + 1000,
    }).degraded.filter((d) => d.cause === "drill");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.sentence).toContain("users 7 became 1");
  });
});
