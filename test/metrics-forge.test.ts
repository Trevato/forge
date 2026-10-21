/** forge_http_request_duration_seconds only grows: no value drops across an hour boundary (#4013). */

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createRouteTiming, MAX_TOTAL_PATTERNS, readTotals } from "../src/core/route_timing.ts";
import { migrate } from "../src/kernel/migrate.ts";
import { migrationFiles } from "../src/core/schema.ts";
import { forgeMetrics } from "../src/metrics/forge.ts";

/** Every sample line of the family, `name{labels}` → value. */
const samples = (text: string): Map<string, number> =>
  new Map(
    [...text.matchAll(/^(forge_http_request_duration_seconds_\w+\{[^}]*\}) (\S+)$/gm)].map(
      (m) => [m[1]!, Number(m[2])],
    ),
  );

test("no bucket, count or sum drops as the hours pass", () => {
  const db = new Database(":memory:");
  migrate(db, migrationFiles);
  const hour = 3_600_000;
  let clock = Date.UTC(2020, 0, 6, 10, 59);
  const timing = createRouteTiming(db, () => clock);
  const scrapes: Map<string, number>[] = [];
  // 10:59, 11:30, 12:30 and 13:30: the 10:00 hour leaves any one- or two-hour window.
  for (const [i, step] of [0, 31 * 60_000, hour, hour].entries()) {
    clock += step;
    if (i < 2) timing.record("/a/:id", 3); // 0.003 s, in the le="0.005" bucket
    if (i === 0) timing.record("/b", 700); // 0.7 s, in the le="1" bucket
    timing.flush();
    scrapes.push(samples(forgeMetrics(db)));
  }
  for (let i = 1; i < scrapes.length; i++)
    for (const [key, before] of scrapes[i - 1]!) expect(scrapes[i]!.get(key) ?? -1).toBeGreaterThanOrEqual(before);
  const last = scrapes.at(-1)!;
  expect(last.get('forge_http_request_duration_seconds_count{pattern="/a/:id"}')).toBe(2);
  expect(last.get('forge_http_request_duration_seconds_bucket{pattern="/a/:id",le="0.002"}')).toBe(0);
  expect(last.get('forge_http_request_duration_seconds_bucket{pattern="/a/:id",le="0.005"}')).toBe(2);
  expect(last.get('forge_http_request_duration_seconds_sum{pattern="/a/:id"}')).toBe(0.006);
  expect(last.get('forge_http_request_duration_seconds_bucket{pattern="/b",le="0.5"}')).toBe(0);
  expect(last.get('forge_http_request_duration_seconds_bucket{pattern="/b",le="1"}')).toBe(1);
  expect(last.get('forge_http_request_duration_seconds_bucket{pattern="/b",le="+Inf"}')).toBe(1);
  expect(last.get('forge_http_request_duration_seconds_sum{pattern="/b"}')).toBe(0.7);
  timing.stop();
  db.close();
});

test("the HELP line says since the process started, not the last hour", () => {
  const db = new Database(":memory:");
  expect(forgeMetrics(db)).toContain(
    "# HELP forge_http_request_duration_seconds Seconds the forge took to answer a request, by route pattern, since the process started.",
  );
  db.close();
});

test("totals are kept per database and stop growing new patterns at the cap", () => {
  const a = new Database(":memory:");
  const b = new Database(":memory:");
  const ta = createRouteTiming(a);
  for (let i = 0; i < MAX_TOTAL_PATTERNS + 5; i++) ta.record(`/p${i}`, 1);
  expect(readTotals(a).size).toBe(MAX_TOTAL_PATTERNS);
  expect(readTotals(b).size).toBe(0);
  ta.record("/p0", 1);
  expect(readTotals(a).get("/p0")!.counts[0]).toBe(2);
});
