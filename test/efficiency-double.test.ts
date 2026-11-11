/** When a cost is bad (#7558): 2x for 2 hours, or a ceiling; flat files nothing; the #7541 series files within 3 hours. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { HOUR_MS } from "../src/efficiency/baseline.ts";
import { causeOf } from "../src/efficiency/causes.ts";
import { putSample } from "../src/efficiency/store.ts";
import { quietLogs } from "./helpers/globals.ts";
import { forge, flat, issuesOf, MiB, NPM, T0, watch } from "./helpers/efficiency.ts";

quietLogs();
let f: Awaited<ReturnType<typeof forge>>;
beforeAll(async () => { f = await forge(); });
afterAll(() => f.done());
const reset = () => { f.app.db.exec("DELETE FROM efficiency_sample; DELETE FROM efficiency_finding; DELETE FROM comment; DELETE FROM issue"); };

test("a flat series files nothing", () => {
  reset();
  flat(f.app, T0);
  for (let h = 0; h < 6; h++) {
    const r = watch(f.app, T0 + h * HOUR_MS + 600_000, { [NPM]: 50 * MiB });
    expect(r.findings).toEqual([]);
  }
  expect(issuesOf(f.app, f.repoId)).toEqual([]);
});

test("npm bytes jump 10x for 2 hours: one issue with cause, numbers and baseline", () => {
  reset();
  flat(f.app, T0);
  expect(watch(f.app, T0 + 600_000, { [NPM]: 500 * MiB }).findings).toEqual([]); // one hour is not yet two
  expect(issuesOf(f.app, f.repoId)).toEqual([]);
  const r = watch(f.app, T0 + HOUR_MS + 600_000, { [NPM]: 500 * MiB });
  expect(r.findings).toHaveLength(1);
  expect(r.findings[0]!.probe?.number).toBe(500 * MiB);
  const issues = issuesOf(f.app, f.repoId);
  expect(issues).toHaveLength(1);
  expect(issues[0]!.title).toContain("npm registry bytes");
  expect(issues[0]!.body).toContain("500.00 MiB");
  expect(issues[0]!.body).toContain("baseline 50.00 MiB");
  expect(issues[0]!.body).toContain("registry.npmjs.org:443");
  expect(issues[0]!.body).toContain("2x");
});

test("an hour over the ceiling files at once", () => {
  reset();
  flat(f.app, T0);
  watch(f.app, T0 + 600_000, { [NPM]: causeOf(NPM)!.ceiling! });
  expect(issuesOf(f.app, f.repoId)[0]!.body).toContain("ceiling");
});

test("a doubling under the floor is noise and files nothing", () => {
  reset();
  flat(f.app, T0, 1 * MiB);
  watch(f.app, T0 + 600_000, { [NPM]: 10 * MiB });
  watch(f.app, T0 + HOUR_MS + 600_000, { [NPM]: 10 * MiB });
  expect(issuesOf(f.app, f.repoId)).toEqual([]);
});

test("replaying #7541 (~1.25 GiB an hour over a quiet week) files within 3 hours of the first bad hour", () => {
  reset();
  flat(f.app, T0, 40 * MiB);
  const bad = 1.25 * 1024 * MiB;
  let filedAfter = -1;
  for (let h = 0; h < 6 && filedAfter < 0; h++) {
    watch(f.app, T0 + h * HOUR_MS + 3_500_000, { [NPM]: bad });
    if (issuesOf(f.app, f.repoId).length > 0) filedAfter = h + 1;
  }
  expect(filedAfter).toBeGreaterThan(0);
  expect(filedAfter).toBeLessThanOrEqual(3);
});

test("a forge with under three days of history files nothing by doubling", () => {
  reset();
  for (let h = 1; h <= 30; h++) putSample(f.app.db, NPM, T0 - h * HOUR_MS, 50 * MiB);
  watch(f.app, T0 + 600_000, { [NPM]: 900 * MiB });
  watch(f.app, T0 + HOUR_MS + 600_000, { [NPM]: 900 * MiB });
  expect(issuesOf(f.app, f.repoId)).toEqual([]);
});
