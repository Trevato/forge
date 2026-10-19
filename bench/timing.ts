/**
 * What recording a request's time costs: `record` plus the header, per
 * request. The budget is 0.2 ms; it is measured in microseconds.
 *
 *   bun run bench/timing.ts
 */

import { Database } from "bun:sqlite";
import { createRouteTiming, serverTiming } from "../src/core/route_timing.ts";
import { migrate } from "../src/kernel/migrate.ts";
import { migrationFiles } from "../src/core/schema.ts";

const BUDGET_MS = 0.2;
const N = 200_000;
const db = new Database(":memory:");
migrate(db, migrationFiles);
const timing = createRouteTiming(db);
const patterns = ["/:owner/:name", "/api/v1/repos/:o/:n", "/", "/:owner/:name/pulls/:n"];

const start = performance.now();
for (let i = 0; i < N; i++) {
  const ms = performance.now() - start;
  timing.record(patterns[i % patterns.length]!, (i % 40) / 4);
  serverTiming(ms);
}
const per = (performance.now() - start) / N;
timing.stop();
console.log(`record + header: ${(per * 1000).toFixed(2)} µs/request (budget ${BUDGET_MS * 1000} µs)`);
if (per > BUDGET_MS) {
  console.error("over budget");
  process.exit(1);
}
