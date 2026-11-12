/** slowestRoutes: budgeted routes only, worst over budget first, capped (#11476). */
import { expect, test } from "bun:test";
import { createPerfRecord } from "../src/perf/record.ts";
import { slowestRoutes } from "../src/perf/watch.ts";

const at = Date.now();
const fill = (rec: ReturnType<typeof createPerfRecord>, route: string, ms: number) => {
  for (let i = 0; i < 5; i++) rec.add(route, { at, ms, signedIn: true, phases: [{ name: "app", ms, hit: false }, { name: "read", ms: ms / 2, hit: false }] });
};

test("a route with no budget is omitted; the rest are ordered by p95 over budget", () => {
  const rec = createPerfRecord(() => true);
  fill(rec, "/boards", 100);
  fill(rec, "/explore", 2000);
  fill(rec, "/no-such-budgeted-route", 99999);
  const rows = slowestRoutes(rec, at + 1);
  expect(rows.map((r) => r.route)).toEqual(["/explore", "/boards"]);
  expect(rows[0]).toEqual({ route: "/explore", p95Ms: 2000, budgetMs: 800, n: 5, slowestPhase: "read" });
});

test("the list is capped at 10", () => {
  const rec = createPerfRecord(() => true);
  const routes = ["/boards", "/explore", "/", "/issues", "/pulls", "/crew", "/system", "/telemetry", "/security", "/search", "/forks", "/notes"];
  for (const r of routes) fill(rec, r, 5000);
  const budgeted = slowestRoutes(rec, at + 1, 100).length;
  expect(budgeted).toBeGreaterThan(2);
  expect(slowestRoutes(rec, at + 1, 2).length).toBe(Math.min(2, budgeted));
  expect(slowestRoutes(rec, at + 1).length).toBeLessThanOrEqual(10);
});
