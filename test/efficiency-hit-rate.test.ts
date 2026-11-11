/** The install cache hit rate (#7558): counted per contained install, and bad when it falls to half its baseline for 2 hours. */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { HOUR_MS } from "../src/efficiency/baseline.ts";
import { hitRateLastHour, MIN_INSTALLS, noteInstall, resetInstalls } from "../src/efficiency/installs.ts";
import { hourVerdict } from "../src/efficiency/judge.ts";
import { causeOf, show } from "../src/efficiency/causes.ts";
import { meteredInstall } from "../src/checks/install.ts";
import { resetEgressTotals } from "../src/apps/egress.ts";
import { quietLogs } from "./helpers/globals.ts";
import { putSample, readSeries } from "../src/efficiency/store.ts";
import { forge, issuesOf, seed, T0, watch } from "./helpers/efficiency.ts";

quietLogs();
const HIT = "install-cache-hit-rate";
let f: Awaited<ReturnType<typeof forge>>;
beforeAll(async () => { f = await forge(); });
afterAll(() => f.done());
beforeEach(() => {
  resetInstalls();
  f.app.db.exec("DELETE FROM efficiency_sample; DELETE FROM efficiency_finding; DELETE FROM comment; DELETE FROM issue");
});

test("the counter gives the share of the last hour's installs that missed no cache, and none under 5 installs", () => {
  const t = T0 + 600_000;
  for (let i = 0; i < MIN_INSTALLS - 1; i++) noteInstall(false, t);
  expect(hitRateLastHour(t)).toBeUndefined();
  noteInstall(true, t); // 4 hits, 1 miss
  expect(hitRateLastHour(t)).toBe(0.8);
  expect(hitRateLastHour(t + HOUR_MS + 1)).toBeUndefined(); // aged out
});

test("a contained install over 1 MiB from the registry is counted as a miss", async () => {
  resetEgressTotals();
  await meteredInstall("app:t/preview", "r1", async () => 1, () => {});
  const { installsLastHour } = await import("../src/efficiency/installs.ts");
  expect(installsLastHour(Date.now())).toEqual({ installs: 1, misses: 0 });
  await meteredInstall(undefined, undefined, async () => 1, () => {}); // uncontained: not counted
  expect(installsLastHour(Date.now()).installs).toBe(1);
});

test("a hit rate at or under half its baseline is a fall; above half, or a baseline under the floor, is not", () => {
  const c = causeOf(HIT)!;
  const hour = T0;
  const base = (v: number) => new Map(Array.from({ length: 7 }, (_, d) => [hour - (d + 1) * 24 * HOUR_MS, v] as const).concat([[hour, 0]]));
  expect(hourVerdict(c, new Map(base(0.9)).set(hour, 0.45), hour)?.fell).toBe(true);
  expect(hourVerdict(c, new Map(base(0.9)).set(hour, 0.46), hour)?.fell).toBe(false);
  expect(hourVerdict(c, new Map(base(0.4)).set(hour, 0), hour)?.fell).toBe(false); // baseline under the 50% floor
  expect(hourVerdict(c, new Map(base(0.9)).set(hour, 1), hour)?.doubled).toBe(false); // a rise is never bad here
  expect(show(c, 0.456)).toBe("45.6%");
});

test("a hit rate that falls for 2 hours files one issue naming the rate, its baseline and the install path", () => {
  seed(f.app, HIT, T0, 8 * 24, () => 0.95);
  expect(watch(f.app, T0 + 600_000, { [HIT]: 0.2 }).findings).toEqual([]); // one hour is not two
  const r = watch(f.app, T0 + HOUR_MS + 600_000, { [HIT]: 0.2 });
  expect(r.findings).toHaveLength(1);
  const issues = issuesOf(f.app, f.repoId);
  expect(issues).toHaveLength(1);
  expect(issues[0]!.title).toContain("install cache hit rate");
  expect(issues[0]!.title).toContain("below");
  expect(issues[0]!.body).toContain("20.0%");
  expect(issues[0]!.body).toContain("baseline 95.0%");
  expect(issues[0]!.body).toContain("at most half");
  expect(issues[0]!.body).toContain("meteredInstall");
});

test("a steady hit rate files nothing", () => {
  seed(f.app, HIT, T0, 8 * 24, () => 0.95);
  for (let h = 0; h < 4; h++) expect(watch(f.app, T0 + h * HOUR_MS + 600_000, { [HIT]: 0.9 }).findings).toEqual([]);
  expect(issuesOf(f.app, f.repoId)).toEqual([]);
});

test("a second, higher hit rate in the same hour does not hide a fall: the lower reading stands", () => {
  seed(f.app, HIT, T0, 8 * 24, () => 0.95);
  watch(f.app, T0 + 600_000, { [HIT]: 0.2 });
  watch(f.app, T0 + HOUR_MS + 600_000, { [HIT]: 0.2 });
  watch(f.app, T0 + HOUR_MS + 1_800_000, { [HIT]: 0.9 }); // a restart's pass in the same hour, kinder
  expect(readSeries(f.app.db, HIT, T0 + HOUR_MS).get(T0 + HOUR_MS)).toBe(0.2);
  expect(issuesOf(f.app, f.repoId)).toHaveLength(1);
  // A rising cost keeps the larger of two readings in one hour.
  putSample(f.app.db, "npm-registry-bytes", T0, 10);
  putSample(f.app.db, "npm-registry-bytes", T0, 5);
  expect(readSeries(f.app.db, "npm-registry-bytes", T0).get(T0)).toBe(10);
});
