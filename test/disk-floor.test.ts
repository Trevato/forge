/**
 * #10850 item 5: the parent protects itself. Below 15% free on its own
 * volume no child forge is made, no child cell starts, and the owner reads
 * one line in vitals. Each is tried against a disk this test hands in.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { provideDiskForTest, type DiskReading } from "../src/kernel/disk_reading.ts";
import { vitals } from "../src/kernel/vitals.ts";
import { cellChildren, stopCellChildren } from "../src/spawn/cell.ts";
import { DISK_FLOOR, floorRefusal } from "../src/spawn/disk_floor.ts";
import { quotaFull, quotaRefusal } from "../src/spawn/quota.ts";

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
      expect(v.needs).toEqual(["Disk is under the 15% the forge keeps for itself: 12% free. No child forge is made or started until room is made."]);
      const at15 = vitals({ db: app.db, signals: app.signals, dataDir: app.config.dataDir, disk: () => ({ freeBytes: 15, totalBytes: 100 }) });
      expect(at15.degraded.map((d) => d.cause)).toEqual([]);
    } finally {
      app.close();
    }
  });
});
