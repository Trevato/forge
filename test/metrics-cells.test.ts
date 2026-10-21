/** `/metrics` serves the app series: `forge_app_up` moves when an app sleeps, a cell's figures appear once recorded, a private app is named by id only (#3752). */

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { CellCounter } from "../src/apps/contain.ts";
import { appFamilies, forgeMetrics, type AppReading } from "../src/metrics/forge.ts";
import { openMetrics } from "../src/metrics/openmetrics.ts";

const app = (state: "running" | "asleep"): AppReading[] => [
  { id: "app1", slug: "notes", private: false, envs: [{ env: "production", state }] },
  { id: "app2", slug: "secret-plans", private: true, envs: [{ env: "pull-3", state: "running" }] },
];
const cell = (label: string): CellCounter => ({ key: 1, label, cpuUsec: 2_500_000, memoryBytes: 4096 });
const text = (apps: AppReading[], cells: CellCounter[]) => openMetrics(appFamilies({ apps, cells }));

test("forge_app_up is 1 while running and 0 once the app sleeps", () => {
  expect(text(app("running"), [])).toContain('forge_app_up{app="notes",env="production"} 1');
  expect(text(app("asleep"), [])).toContain('forge_app_up{app="notes",env="production"} 0');
});

test("a cell's figures appear when the watch has read it, and not before", () => {
  expect(text(app("running"), [])).not.toContain("forge_cell_memory_bytes{");
  const out = text(app("running"), [cell("app:notes/production")]);
  expect(out).toContain('forge_cell_cpu_seconds_total{app="notes",env="production"} 2.5');
  expect(out).toContain('forge_cell_memory_bytes{app="notes",env="production"} 4096');
});

test("a private app appears under its id only", () => {
  const out = text(app("running"), [cell("app:secret-plans/pull-3"), cell("check:x")]);
  expect(out).toContain('forge_app_up{app="app2",env="pull-3"} 1');
  expect(out).toContain('forge_cell_memory_bytes{app="app2",env="pull-3"} 4096');
  expect(out).not.toContain("secret-plans");
  expect(out).not.toContain("check:x");
});

test("forgeMetrics carries the families as Prometheus text without a trailing EOF", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE route_timing (hour TEXT, pattern TEXT, bucket INTEGER, n INTEGER, sum_us INTEGER)");
  const body = forgeMetrics(db, { apps: app("running"), cells: [] });
  expect(body).toContain("# TYPE forge_app_up gauge");
  expect(body).toContain("# TYPE forge_cell_cpu_seconds counter");
  expect(body).not.toContain("# EOF");
});

test("two cells under one label (a deploy's old and new) are one series, summed, and the scrape does not throw", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE route_timing (hour TEXT, pattern TEXT, bucket INTEGER, n INTEGER, sum_us INTEGER)");
  const cells = [cell("app:notes/production"), { ...cell("app:notes/production"), key: 2 }];
  const body = forgeMetrics(db, { apps: app("running"), cells });
  expect(body).toContain('forge_cell_memory_bytes{app="notes",env="production"} 8192');
  expect(body).toContain('forge_cell_cpu_seconds_total{app="notes",env="production"} 5');
});
