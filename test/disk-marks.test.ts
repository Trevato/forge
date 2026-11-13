/**
 * #11800: the owner's phone hears at 70% and 80% of the disk under the
 * forge's data used, once per crossing and Recovered once, and /system
 * names the five largest directories under it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { observe, owned, type Watch } from "../src/crew/incidents.ts";
import { vitals } from "../src/kernel/vitals.ts";
import { largest, largestDirsCache, measureLargestDirs, type LargestDirs } from "../src/system/largest_dirs.ts";
import { largestDirsSection } from "../src/web/pages/system.ts";

const tmp = mkdtempSync(join(tmpdir(), "disk-marks-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("vitals names the highest mark passed", () => {
  const app = createApp({ dataDir: join(tmp, "vitals"), url: "https://f.test" });
  afterAll(() => app.close());
  const at = (usedPct: number) =>
    vitals({ db: app.db, signals: app.signals, dataDir: app.config.dataDir, disk: () => ({ freeBytes: 100 - usedPct, totalBytes: 100 }) });

  test("69% says nothing, 70% and 80% say their mark, the floor says only the floor", () => {
    expect(at(69).degraded.map((d) => d.cause)).toEqual([]);
    expect(at(70).degraded.map((d) => d.cause)).toEqual(["disk-70"]);
    expect(at(70).needs).toEqual(["Disk under the forge's data is 70% used, past the 70% mark."]);
    expect(at(79).degraded.map((d) => d.cause)).toEqual(["disk-70"]);
    expect(at(80).degraded.map((d) => d.cause)).toEqual(["disk-80"]);
    expect(at(88).degraded.map((d) => d.cause)).toEqual(["disk-floor"]);
  });

  test("the pager owns both marks", () => {
    expect(owned("disk-70")).toBe(true);
    expect(owned("disk-80")).toBe(true);
  });
});

describe("the owner hears once per crossing", () => {
  const MIN = 60_000;
  const mark = (pct: 70 | 80) => ({ cause: `disk-${pct}`, sentence: `Disk under the forge's data is ${pct}% used, past the ${pct}% mark.` });

  test("70% pages once, 80% once more, back under 80% and under 70% each say Recovered once", () => {
    const watch: Watch = new Map();
    let t = 0;
    const pages: string[] = [];
    const recovered: string[] = [];
    const step = (minutes: number, present: { cause: string; sentence: string }[]) => {
      t += minutes * MIN;
      const due = observe(watch, present, t);
      for (const k of due.pages) watch.get(k)!.paged = true;
      for (const k of due.recovered) watch.delete(k);
      pages.push(...due.pages);
      recovered.push(...due.recovered);
    };
    step(0, []);
    step(6, []);
    expect(pages).toEqual([]);
    step(1, [mark(70)]);
    step(6, [mark(70)]);
    for (let i = 0; i < 6; i++) step(5, [mark(70)]);
    expect(pages).toEqual(["disk-70"]);
    // Past 80% vitals names only disk-80: the 70% mark holds, not paged anew nor recovered.
    step(1, [mark(80)]);
    step(6, [mark(80)]);
    for (let i = 0; i < 6; i++) step(5, [mark(80)]);
    expect(pages).toEqual(["disk-70", "disk-80"]);
    expect(recovered).toEqual([]);
    step(1, [mark(70)]);
    step(6, [mark(70)]);
    expect(recovered).toEqual(["disk-80"]);
    step(1, []);
    step(6, []);
    step(30, []);
    expect(recovered).toEqual(["disk-80", "disk-70"]);
    expect(pages).toEqual(["disk-70", "disk-80"]);
  });

  test("a disk that climbs past the floor keeps the marks under it", () => {
    const watch: Watch = new Map();
    const floor = { cause: "disk-floor", sentence: "floor" };
    observe(watch, [mark(80)], 0);
    expect(observe(watch, [mark(80)], 6 * MIN).pages).toEqual(["disk-80"]);
    watch.get("disk-80")!.paged = true;
    observe(watch, [floor], 7 * MIN);
    const due = observe(watch, [floor], 20 * MIN);
    expect(due.pages).toEqual(["disk-floor"]);
    expect(due.recovered).toEqual([]);
  });
});

describe("the five largest directories under the forge's data", () => {
  test("ordered by size, largest first, five at most", () => {
    const sizes = [
      { name: "a", bytes: 3 },
      { name: "b", bytes: 10 },
      { name: "c", bytes: 1 },
      { name: "d", bytes: 7 },
      { name: "e", bytes: 7 },
      { name: "f", bytes: 2 },
    ];
    expect(largest(sizes).map((d) => d.name)).toEqual(["b", "d", "e", "a", "f"]);
  });

  test("measured from the disk: a directory's files and its nested ones count, top-level files do not", async () => {
    const data = join(tmp, "measure");
    mkdirSync(join(data, "big", "deep"), { recursive: true });
    mkdirSync(join(data, "small"), { recursive: true });
    writeFileSync(join(data, "big", "deep", "blob"), Buffer.alloc(256 * 1024, 1));
    writeFileSync(join(data, "small", "note"), "x");
    writeFileSync(join(data, "loose.db"), Buffer.alloc(1024 * 1024, 1));
    const found = await measureLargestDirs(data);
    expect(found.dirs.map((d) => d.name)).toEqual(["big", "small"]);
    expect(found.dirs[0]!.bytes).toBeGreaterThanOrEqual(256 * 1024);
  });

  test("measured at most once a minute, and a slow walk is not waited on past the wait", async () => {
    let now = 0;
    let walks = 0;
    let release: (() => void) | undefined;
    const value: LargestDirs = { at: "2026-11-12T00:00:00.000Z", dirs: [{ name: "repos", bytes: 5 }] };
    const cache = largestDirsCache(async () => {
      walks++;
      if (walks === 2) await new Promise<void>((r) => (release = r));
      return value;
    }, () => now);
    expect(await cache.read("/d")).toEqual(value);
    now += 30_000;
    expect(await cache.read("/d")).toEqual(value);
    expect(cache.peek("/d")).toEqual(value);
    expect(walks).toBe(1);
    now += 31_000;
    const started = performance.now();
    expect(await cache.read("/d", 20)).toEqual(value);
    expect(performance.now() - started).toBeLessThan(500);
    expect(walks).toBe(2);
    release!();
  });

  test("/system's section names each with its size, escaped", () => {
    const out = String(largestDirsSection({ at: "2026-11-12T00:00:00.000Z", dirs: [{ name: "<repos>", bytes: 2 * 1024 ** 3 }] }));
    expect(out).toContain("&lt;repos&gt;");
    expect(out).not.toContain("<repos>");
    expect(out).toContain('data-bytes="2147483648"');
    expect(String(largestDirsSection(null))).toContain("Being measured");
  });
});
