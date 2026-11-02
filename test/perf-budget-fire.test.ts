import { expect, test } from "bun:test";
import { createPerfRecord } from "../src/perf/record.ts";
import { evaluate, fresh, WINDOW_MS } from "../src/perf/watch.ts";

const now = 10_000_000;
function seed(pattern: string, total: number, phase: number, n = 100, hit = false) {
  const r = createPerfRecord();
  for (let i = 0; i < n; i++)
    r.add(pattern, {
      at: now - WINDOW_MS + (i * WINDOW_MS) / n,
      ms: total,
      signedIn: false,
      phases: [{ name: "app", ms: total, hit: false }, { name: "kpis", ms: phase, hit }],
    });
  return r;
}
test("home with kpis at 4.4 s files one finding naming route, phase, p95, share", () => {
  const f = evaluate(seed("/", 4600, 4400), now);
  expect(f.length).toBe(1);
  expect(f[0]!.key).toBe("performance-watcher:/:kpis");
  expect(f[0]!.evidence).toContain("Slowest phase: kpis, p95 4400 ms, 96%");
  expect(f[0]!.evidence).toContain("p95 4600 ms");
});
test("a cache that never hits is named", () => {
  expect(evaluate(seed("/", 4600, 4400), now)[0]!.evidence).toContain("kpis never hit in 100 requests");
});
test("a fast route, too few requests, or a short spell file nothing", () => {
  expect(evaluate(seed("/", 30, 20), now)).toEqual([]);
  expect(evaluate(seed("/", 4600, 4400, 5), now)).toEqual([]);
  const r = createPerfRecord();
  for (let i = 0; i < 50; i++) r.add("/", { at: now - 1000, ms: 5000, signedIn: false, phases: [] });
  expect(evaluate(r, now)).toEqual([]);
});
test("a finding is offered once", () => {
  const filed = new Set<string>();
  const f = evaluate(seed("/", 4600, 4400), now);
  expect(fresh(f, filed).length).toBe(1);
  expect(fresh(f, filed).length).toBe(0);
});
test("a busy route with far more than 1000 requests in the window still files", () => {
  const r = seed("/", 4600, 4400, 5000);
  expect(r.traffic("/", 0).length).toBeGreaterThan(1000);
  expect(evaluate(r, now).length).toBe(1);
});
test("samples older than the window are dropped; a young route is not judged", () => {
  const r = createPerfRecord();
  for (let i = 0; i < 100; i++) r.add("/", { at: i, ms: 5000, signedIn: false, phases: [] });
  r.add("/", { at: 3 * WINDOW_MS, ms: 5000, signedIn: false, phases: [] });
  expect(r.traffic("/", 0).length).toBe(1);
  expect(r.first("/")).toBe(0);
});
test("the title is stable, the numbers are in the body", () => {
  const f = evaluate(seed("/", 4600, 4400), now)[0]!;
  expect(f.title).toBe("/ is over its budget: kpis");
  expect(f.evidence).toContain("p95 4600 ms");
});
