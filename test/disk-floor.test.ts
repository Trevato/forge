/**
 * #10850 item 5: the parent protects itself. Below 15% free on its own
 * volume no child forge is made, no child cell starts, and the owner reads
 * one line in vitals. #10873: a child already awake is put to sleep and kept
 * asleep with the floor's one line, no app or check cell starts, and the
 * owner is paged once per crossing. Each is tried against a disk this test
 * hands in.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import type { CellSpec } from "../src/apps/contain.ts";
import { parseManifest } from "../src/apps/manifest.ts";
import { childEnv, runStep, startProcess, type StartInput } from "../src/apps/process.ts";
import { spawnForge } from "../src/actions/spawn.ts";
import { createUser } from "../src/core/users.ts";
import { observe, type Watch } from "../src/crew/incidents.ts";
import { bootHostedChild, childAwake, closeHostedChildren, sleepBelowFloor, wakeGate } from "../src/spawn/host.ts";
import { hostedPlacement } from "../src/spawn/placement.ts";
import { quietLogs } from "./helpers/globals.ts";
import { provideDiskForTest, type DiskReading } from "../src/kernel/disk_reading.ts";
import { vitals } from "../src/kernel/vitals.ts";
import { cellChildren, stopCellChildren } from "../src/spawn/cell.ts";
import { usedRefusal } from "../src/apps/disk_guard.ts";
import { RELEASE_DISK_USED_MAX } from "../src/keeper/cadence.ts";
import { DISK_FLOOR, floorRefusal } from "../src/spawn/disk_floor.ts";
import { quotaFull, quotaRefusal } from "../src/spawn/quota.ts";

quietLogs();

const tmp = mkdtempSync(join(tmpdir(), "disk-floor-"));
const GiB = 1024 ** 3;
const reading = (freeGiB: number, totalGiB = 100): DiskReading => ({ freeBytes: freeGiB * GiB, totalBytes: totalGiB * GiB });
const roomy = (): DiskReading => reading(900, 1000);

afterEach(() => provideDiskForTest(roomy));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("floorRefusal", () => {
  test("the floor is 15%", () => expect(DISK_FLOOR).toBe(0.15));

  test("14.9 GiB free of 100 is under it, and the sentence says the figures", () => {
    expect(floorRefusal(tmp, reading(14.9))).toBe(
      "this host's disk has 14.9% free (14.9 of 100.0 GiB), under the 15% it keeps for itself: nothing new starts until room is made",
    );
  });

  test("exactly 15% free is not under it", () => expect(floorRefusal(tmp, reading(15))).toBeUndefined());

  test("the reported pod (314 GiB free of 669) is above it; at 90 GiB free it is not", () => {
    expect(floorRefusal(tmp, reading(314, 669))).toBeUndefined();
    expect(floorRefusal(tmp, reading(90, 669))).toContain("13.5% free");
  });

  test("a disk that cannot be read or reads as empty is not refused", () => {
    expect(floorRefusal(tmp, undefined)).toBeUndefined();
    expect(floorRefusal(tmp, { freeBytes: 0, totalBytes: 0 })).toBeUndefined();
  });

  test("with no reading handed in, it reads the forge's disk reader", () => {
    provideDiskForTest(() => reading(10));
    expect(floorRefusal(tmp)).toContain("10.0% free");
  });
});

describe("below the floor", () => {
  test("no child forge is made, whatever limits are declared, and the New forge page says why", () => {
    provideDiskForTest(() => reading(5));
    expect(quotaRefusal(tmp, "small", {})).toContain("under the 15% it keeps for itself");
    expect(quotaFull(tmp, {})).toContain("under the 15% it keeps for itself");
    provideDiskForTest(roomy);
    expect(quotaRefusal(tmp, "small", {})).toBeUndefined();
  });

  test("a child cell does not start, and its failure names the floor", async () => {
    const app = createApp({ dataDir: join(tmp, "parent"), url: "https://f.test" });
    try {
      provideDiskForTest(() => reading(12));
      const children = cellChildren(app);
      expect(await children.start({ bodyId: "cell-floor", name: "kid", size: "small" })).toBeUndefined();
      expect(children.failure("cell-floor")).toContain("12.0% free");
      expect(children.list()).toEqual([]);
    } finally {
      await stopCellChildren(app);
      app.close();
    }
  });

  test("the owner reads one line in vitals between the floor and nearly full", () => {
    const app = createApp({ dataDir: join(tmp, "vitals"), url: "https://f.test" });
    try {
      const v = vitals({ db: app.db, signals: app.signals, dataDir: app.config.dataDir, disk: () => ({ freeBytes: 12, totalBytes: 100 }) });
      expect(v.degraded.map((d) => d.cause)).toEqual(["disk-floor"]);
      expect(v.needs).toEqual(["Disk is under the 15% the forge keeps for itself: 12% free. Child forges sleep, and no child forge, app or check starts, until room is made."]);
      const at15 = vitals({ db: app.db, signals: app.signals, dataDir: app.config.dataDir, disk: () => ({ freeBytes: 15, totalBytes: 100 }) });
      // At the floor is not under it; 85% used is past the 80% mark (#11800), which says only that.
      expect(at15.degraded.map((d) => d.cause)).toEqual(["disk-80"]);
    } finally {
      app.close();
    }
  });
});

describe("children already awake (#10873)", () => {
  const made: App[] = [];
  afterAll(() => {
    for (const app of made) {
      closeHostedChildren(app);
      app.close();
    }
  });

  const spawned = async (name: string): Promise<App> => {
    const parent = createApp({ dataDir: join(tmp, name), url: "https://forge.test", port: 0 });
    made.push(parent);
    const admin = await createUser(parent.db, { origin: "seed", trusted: true, username: "alice", email: "a@x.invalid", isAdmin: true });
    if (!admin.ok) throw new Error("user");
    const out = await spawnForge(
      parent,
      admin.value,
      { name: "kid", org: "kid", apps: [], carryBriefs: false, carrySubscriptions: false },
      { catalog: [], briefs: [], subscriptions: [] },
      {
        placement: hostedPlacement({ host: "forge.test" }),
        request: new Request("https://forge.test/spawn", { method: "POST", headers: { origin: "https://forge.test" } }),
        url: new URL("https://forge.test/spawn"),
      },
    );
    if (!out.ok) throw new Error(JSON.stringify(out.error));
    await bootHostedChild(parent, "kid");
    return parent;
  };
  const visit = (parent: App, method = "GET") =>
    wakeGate(parent, new Request("https://kid--forge.test/", { method, headers: { host: "kid--forge.test" } }));

  test("above the floor the sweep leaves an awake child alone", async () => {
    const parent = await spawned("awake-roomy");
    expect(childAwake(parent, "kid")).toBe(true);
    expect(await sleepBelowFloor(parent)).toEqual([]);
    expect(childAwake(parent, "kid")).toBe(true);
  });

  test("below it the sweep puts the child to sleep, and its forge answers one plain line until room is made", async () => {
    const parent = await spawned("awake-floor");
    expect(childAwake(parent, "kid")).toBe(true);
    provideDiskForTest(() => reading(12));
    expect(await sleepBelowFloor(parent)).toEqual(["kid"]);
    expect(childAwake(parent, "kid")).toBe(false);
    for (const method of ["GET", "POST"]) {
      const answer = visit(parent, method);
      expect(answer?.status).toBe(503);
      expect(answer?.headers.get("content-type")).toContain("text/plain");
      const said = await answer!.text();
      expect(said.trim().split("\n")).toHaveLength(1);
      expect(said).toContain("12.0% free");
    }
    expect(childAwake(parent, "kid")).toBe(false);
    provideDiskForTest(roomy);
    expect(visit(parent)).toBeUndefined();
  });

  test("a request reaching a child awake below the floor puts it to sleep at once, not at the next look", async () => {
    const parent = await spawned("awake-request");
    provideDiskForTest(() => reading(10));
    expect(visit(parent)?.status).toBe(503);
    await Bun.sleep(20);
    expect(childAwake(parent, "kid")).toBe(false);
  });
});

describe("app and check cells inside the parent (#10873)", () => {
  const manifest = (() => {
    const m = parseManifest(JSON.stringify({ app: { run: "bun server.ts" } }), undefined);
    if (!m.ok) throw new Error("manifest");
    return m.value;
  })();

  test("an app does not start below the floor, and says why", async () => {
    provideDiskForTest(() => reading(14));
    const lines: string[] = [];
    // The floor is read before anything else: the rest of the input is never reached.
    const input = { dir: tmp, dataDir: tmp, manifest, log: (l: string) => lines.push(l), signal: new AbortController().signal } as unknown as StartInput;
    const started = await startProcess(input);
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error.stage).toBe("start");
    expect(started.error.message).toBe(floorRefusal(tmp)!);
    expect(lines.join("\n")).toContain("14.0% free");
  });

  test("a check's cell does not start below the floor, with the same line; a plain step above it runs", async () => {
    const step = (cell?: CellSpec) =>
      runStep("check", "true", { cwd: tmp, env: childEnv({}), log: () => {}, signal: new AbortController().signal, cell });
    provideDiskForTest(() => reading(14));
    // Refused before the cell is opened, so its spec is never read.
    const refused = await step({} as CellSpec);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toBe(floorRefusal(tmp)!);
    provideDiskForTest(roomy);
    expect((await step()).ok).toBe(true);
  });
});

describe("the owner hears once per crossing (#10873)", () => {
  const MIN = 60_000;
  const floor = { cause: "disk-floor", sentence: "Disk is under the 15% the forge keeps for itself: 12% free." };
  const full = { cause: "disk", sentence: "Disk is nearly full: 5% free." };

  test("one page held five minutes, none while it stays, none when it gets worse and better, Recovered once, one page on a new crossing", () => {
    const watch: Watch = new Map();
    let t = 0;
    const look = (present: { cause: string; sentence: string }[]) => observe(watch, present, t);
    const pages: string[] = [];
    const recovered: string[] = [];
    const step = (minutes: number, present: { cause: string; sentence: string }[]) => {
      t += minutes * MIN;
      const due = look(present);
      for (const k of due.pages) watch.get(k)!.paged = true;
      for (const k of due.recovered) watch.delete(k);
      pages.push(...due.pages);
      recovered.push(...due.recovered);
    };
    step(0, [floor]);
    step(6, [floor]);
    expect(pages).toEqual(["disk-floor"]);
    for (let i = 0; i < 12; i++) step(5, [floor]);
    expect(pages).toEqual(["disk-floor"]);
    // Worse: vitals names only "disk"; the floor holds, unpaged anew and not recovered.
    step(1, [full]);
    step(10, [full]);
    step(10, [floor]);
    step(6, [floor]);
    expect(pages).toEqual(["disk-floor", "disk"]);
    expect(recovered).toEqual(["disk"]);
    step(1, []);
    step(6, []);
    expect(recovered).toEqual(["disk", "disk-floor"]);
    step(60, [floor]);
    step(6, [floor]);
    expect(pages).toEqual(["disk-floor", "disk", "disk-floor"]);
  });
});

describe("no step's cell starts at 80% used (#11799)", () => {
  test("the guard is 80% and the child floor stays 15%", () => {
    expect(RELEASE_DISK_USED_MAX).toBe(0.8);
    expect(DISK_FLOOR).toBe(0.15);
  });

  test("81% used is refused with one line; 79% is not", () => {
    expect(usedRefusal(tmp, reading(19))).toContain("81.0% used");
    expect(usedRefusal(tmp, reading(21))).toBeUndefined();
    expect(usedRefusal(tmp, undefined)).toBeUndefined();
  });

  test("a step at 81% logs the line and fails with it; at 79% it runs", async () => {
    const lines: string[] = [];
    const step = (cell?: CellSpec) =>
      runStep("check", "true", { cwd: tmp, env: childEnv({}), log: (l) => lines.push(l), signal: new AbortController().signal, cell });
    provideDiskForTest(() => reading(19));
    const refused = await step({} as CellSpec);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toBe(`check ${usedRefusal(tmp, reading(19))}`);
    expect(lines).toEqual([`check ${usedRefusal(tmp, reading(19))}`]);
    provideDiskForTest(() => reading(21));
    expect((await step()).ok).toBe(true);
  });
});

describe("a big disk with plenty of room (the vxrail: 348 GiB free of 2198, 84% used)", () => {
  const vxrail = { freeBytes: 348 * GiB, totalBytes: 2198 * GiB };
  test("neither the floor nor the build guard refuses at 100 GiB free or more, whatever the share", () => {
    expect(floorRefusal("/", { freeBytes: 100 * GiB, totalBytes: 2198 * GiB })).toBeUndefined();
    expect(usedRefusal("/", vxrail)).toBeUndefined();
  });
  test("under 100 GiB free the shares decide again", () => {
    expect(floorRefusal("/", { freeBytes: 99 * GiB, totalBytes: 2198 * GiB })).toContain("under the 15%");
    expect(usedRefusal("/", { freeBytes: 99 * GiB, totalBytes: 2198 * GiB })).toContain("builds wait for");
  });
});
