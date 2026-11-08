/** The web-vitals table of a check's run page: `vitalsRows` (src/checks/summary.ts) rendered by `vitalsTable` (src/web/studio/vitals.ts); report-only. */

import { describe, expect, test } from "bun:test";
import { vitalsRows } from "../src/checks/summary.ts";
import { parseLooks } from "../src/checks/looks.ts";
import { vitalsLine } from "../src/checks/progress.ts";
import { vitalsBlock } from "../src/web/studio/run.ts";
import { vitalsTable } from "../src/web/studio/vitals.ts";

const recorded = {
  look: "home",
  entries: {
    lcp: [{ startTime: 3100, size: 10 }],
    layoutShift: [{ startTime: 100, value: 0.3 }],
    longtask: [{ duration: 150 }],
  },
};

describe("vitalsRows", () => {
  test("numbers, thresholds and grades from recorded entries", () => {
    expect(vitalsRows([recorded])[0]!.rows).toEqual([
      { vital: "LCP", value: "3100 ms", thresholds: "good ≤ 2500 ms, poor > 4000 ms", grade: "needs-improvement" },
      { vital: "CLS", value: "0.3", thresholds: "good ≤ 0.1, poor > 0.25", grade: "poor" },
      { vital: "TBT", value: "100 ms", thresholds: "good ≤ 200 ms, poor > 600 ms", grade: "good" },
    ]);
  });

  test("a missing LCP is n/a, not zero", () => {
    const lcp = vitalsRows([{ look: "home", entries: {} }])[0]!.rows[0]!;
    expect(lcp).toMatchObject({ vital: "LCP", value: "n/a", grade: "n/a" });
  });

  test("a look without a browser carries its reason and no rows", () => {
    expect(vitalsRows([{ look: "mobile", skipped: "no browser" }])).toEqual([
      { look: "mobile", skipped: "no browser", rows: [], screens: "", sideways: false },
    ]);
  });
});

describe("vitalsTable", () => {
  test("renders the rows inside a scroll wrapper", () => {
    const out = vitalsTable([recorded]).text;
    expect(out).toContain('class="table-scroll"');
    expect(out).toContain("<td>LCP</td><td>3100 ms</td><td>good ≤ 2500 ms, poor &gt; 4000 ms</td><td>needs-improvement</td>");
  });

  test("renders the skipped line", () => {
    expect(vitalsTable([{ look: "mobile", skipped: "no browser" }]).text).toContain("skipped: no browser");
  });

  test("escapes look names", () => {
    const out = vitalsTable([{ look: "<img src=x>", skipped: "no browser" }]).text;
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
  });

  test("no looks, no markup", () => expect(vitalsTable([]).text).toBe(""));
});

describe("the run page's block", () => {
  const looks = [recorded, { look: "mobile", skipped: "no browser" }];

  test("a check run shows the table for the looks it is given", () => {
    const out = vitalsBlock({ kind: "check" }, false, looks).text;
    expect(out).toContain("<td>CLS</td><td>0.3</td>");
    expect(out).toContain("skipped: no browser");
  });

  test("a hidden log, another kind of run, or no looks shows nothing", () => {
    expect(vitalsBlock({ kind: "check" }, true, looks).text).toBe("");
    expect(vitalsBlock({ kind: "deploy" }, false, looks).text).toBe("");
    expect(vitalsBlock({ kind: "check" }, false, []).text).toBe("");
  });
});

describe("vitalsLine", () => {
  test("the terminal's words for the same rows", () => {
    expect(vitalsLine([recorded, { look: "mobile", skipped: "no browser" }])).toBe(
      "vitals home: LCP 3100 ms needs-improvement, CLS 0.3 poor, TBT 100 ms good; mobile: skipped: no browser",
    );
  });

  test("a missing LCP is n/a and carries no grade; no looks, no line", () => {
    expect(vitalsLine([{ look: "a", entries: {} }])).toContain("LCP n/a,");
    expect(vitalsLine([])).toBe("");
  });
});

describe("parseLooks", () => {
  test("keeps valid looks and drops the rest", () => {
    const got = parseLooks([
      recorded,
      { look: "m", skipped: "no browser" },
      { look: "", skipped: "x" },
      { look: "bad", entries: [] },
      { look: "none" },
      "str",
      null,
    ]);
    expect(got.map((l) => l.look)).toEqual(["home", "m"]);
    expect(parseLooks({})).toEqual([]);
  });
});
