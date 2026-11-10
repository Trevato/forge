/**
 * Home's quiet speed note (#10738): p75 LCP and INP over seven days from the
 * first-party beacon's page_vital, "no visitors yet" when empty, and the whole
 * reach read stays at a fixed number of queries however many views there are.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { readReach, NO_REACH, type Reach } from "../src/flow/reach.ts";
import type { Kpis } from "../src/flow/kpis.ts";
import { kpiLines, vitalsNote } from "../src/flow/kpi_words.ts";
import { expectWork } from "./helpers/work.ts";
import { once } from "./helpers/statements.ts";
import { kpiRowFor } from "../src/web/studio/kpi_row.ts";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const kpis = (reach: Reach): Kpis => ({ landedHours: Array<number>(24).fill(0), landed: 0, live: null, builders: { running: 0, slots: 0, idle: null }, spend: { todayUsd: 0, ceilingUsd: null }, medianCheckMs: null, backupAt: null, reach });

describe("home vitals note", () => {
  test("empty says no visitors yet, without a figure", () => {
    expect(vitalsNote(NO_REACH)).toBe("no visitors yet");
    expect(kpiRowFor(kpis(NO_REACH), null, NOW).toString()).toContain("no visitors yet");
  });

  test("only the measured figure shows when one of LCP or INP is missing", () => {
    expect(vitalsNote({ ...NO_REACH, lcpP75: 2500, inpP75: null })).toBe("LCP 2.5 s");
    expect(vitalsNote({ ...NO_REACH, lcpP75: null, inpP75: 120 })).toBe("INP 120 ms");
    expect(kpiRowFor(kpis({ ...NO_REACH, lcpP75: 2500, inpP75: null }), null, NOW).toString()).not.toContain("INP —");
  });

  test("p75 LCP and INP over 7 days, old days left out, one query", async () => {
    const app = createApp({ dataDir: await mkdtemp(join(tmpdir(), "forge-vitals-")), port: 0 });
    const db: Database = app.db;
    const add = (day: string, lcp: number | null, inp: number | null) =>
      db.run("INSERT INTO page_vital (day, at, route, visitor, ttfb, load, lcp, inp, cls) VALUES (?, 0, '/', 'v', 1, 100, ?, ?, 0)", [day, lcp, inp]);
    for (const l of [1000, 2000, 3000, 4000]) add("2026-10-19", l, l / 10);
    add("2026-10-01", 99999, 99999);
    const real = db.query.bind(db);
    let queries = 0;
    (db as unknown as { query: unknown }).query = (sql: string) => {
      if (/page_vital/.test(sql)) queries++;
      return real(sql);
    };
    const reach = readReach(db, NOW);
    expect(queries).toBeLessThanOrEqual(2);
    expect(reach.lcpP75).toBe(3000);
    expect(reach.inpP75).toBe(300);
    expect(vitalsNote(reach)).toBe("LCP 3.0 s · INP 300 ms");
    expect(kpiRowFor(kpis(reach), null, NOW).toString()).toContain("LCP 3.0 s · INP 300 ms");
  });

  test("the terminal line says LCP and INP too, not the old reacts-in words", () => {
    const line = (r: Reach) => kpiLines(kpis(r), null, NOW).find((l) => l.startsWith("Reported page speed"))!;
    expect(line({ ...NO_REACH, loadP75: 900, lcpP75: 2500, inpP75: 120 })).toBe("Reported page speed loads in 900 ms, LCP 2.5 s · INP 120 ms");
    expect(line(NO_REACH)).toBe("Reported page speed no page views measured yet, no visitors yet");
  });

  test("reading a seeded week of 3000 views stays at a fixed few statements", async () => {
    const app = createApp({ dataDir: await mkdtemp(join(tmpdir(), "forge-vitals-")), port: 0 });
    const db: Database = app.db;
    const ins = db.prepare("INSERT INTO page_vital (day, at, route, visitor, ttfb, load, lcp, inp, cls) VALUES ('2026-10-19', 0, '/', ?, 1, ?, ?, ?, 0)");
    db.transaction(() => { for (let i = 0; i < 3000; i++) ins.run(`v${i % 200}`, 100 + i, 1000 + i, 50 + (i % 300)); })();
    // Count work, not a clock (#7824): a week of 3000 views is read in two statements, whatever the row count.
    expectWork(await once(db, () => { readReach(db, NOW); }), { max: 4 });
  });
});
