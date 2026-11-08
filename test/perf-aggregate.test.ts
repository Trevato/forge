import { expect, test } from "bun:test";
import { createPerfRecord, MAX_SAMPLES, parseServerTiming, summarize } from "../src/perf/record.ts";

const at = 1_000_000;
test("p50/p95/p99 and each phase are kept per pattern", () => {
  const r = createPerfRecord();
  for (let i = 1; i <= 100; i++)
    r.add("/", { at, ms: i, signedIn: false, phases: [{ name: "kpis", ms: i / 2, hit: i % 2 === 0 }] });
  const s = summarize(r.traffic("/", 0))!;
  expect([s.n, s.p50, s.p95, s.p99]).toEqual([100, 50, 95, 99]);
  expect(s.phases[0]).toMatchObject({ name: "kpis", hits: 50, n: 100 });
  expect(s.phases[0]!.share).toBeCloseTo(0.5);
});
test("memory is capped", () => {
  const r = createPerfRecord();
  for (let i = 0; i < MAX_SAMPLES + 50; i++) r.add("/x", { at, ms: 1, signedIn: true, phases: [] });
  expect(r.traffic("/x", 0).length).toBeLessThanOrEqual(MAX_SAMPLES);
});
test("a Server-Timing header becomes phases, hits marked", () => {
  expect(parseServerTiming('app;dur=5.0, kpis;dur=4400.0;desc="hit"')).toEqual([
    { name: "app", ms: 5, hit: false },
    { name: "kpis", ms: 4400, hit: true },
  ]);
});
