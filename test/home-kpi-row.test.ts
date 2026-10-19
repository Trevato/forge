/** Home's figures row (#2871): the four tiles, their links, studio words only, a sparkline of 24 points. */
import { describe, expect, test } from "bun:test";
import { checkTime, kpiLines, sparkText } from "../src/flow/kpi_words.ts";
import { running } from "../src/kernel/version.ts";
import { feedCss } from "../src/web/studio/feed_style.ts";
import { kpiRowFor, liveNow, sparkline } from "../src/web/studio/kpi_row.ts";

const hours = (n: number) => Array.from({ length: 24 }, (_, i) => (i === 3 ? n : 0));

describe("home kpi row", () => {
  test("four tiles with their links and figures", () => {
    const out = kpiRowFor(
      { landedHours: hours(6), landed: 6, live: null, builders: { running: 2, slots: 4 }, medianCheckMs: 185_000 },
      { sha: "abcdef0123456", at: "2026-10-19T11:00:00.000Z" },
    ).toString();
    expect(out).toContain('<span class="sha">abcdef0</span>');
    expect(out).toContain("Shipped per hour");
    expect(out).toContain("0.3");
    expect(out).toContain("6 changes in 24 h");
    expect(out).toContain("abcdef0");
    expect(out).not.toContain(">abcdef01"); // shortened on screen; the whole id is in the title
    expect(out).toContain("3m 05s");
    for (const href of ["/board", "/releases", "/boards"]) expect(out).toContain(`href="${href}"`);
  });

  test("the whole figure is in the title and the link's label, rounded and in studio words", () => {
    const out = kpiRowFor(
      { landedHours: hours(7), landed: 7, live: null, builders: { running: 2, slots: 4 }, medianCheckMs: 185_000 },
      { sha: "abcdef0123456", at: "2026-10-19T11:00:00.000Z" },
    ).toString();
    expect(out).toContain('title="0.29"');
    expect(out).not.toContain("0.2916");
    expect(out).toContain('title="3m 05s"');
    expect(out).not.toContain(" ms");
    expect(out).toContain('aria-label="Live version: abcdef0123456, Live since 2026-10-19T11:00:00.000Z"');
    expect(out).toContain('aria-label="Shipped per hour: 0.29, 7 changes in 24 h"');
  });

  test("empty figures say so", () => {
    const out = kpiRowFor({ landedHours: hours(0), landed: 0, live: null, builders: { running: 2, slots: 4 }, medianCheckMs: null }, null).toString();
    expect(out).toContain("Nothing live yet");
    expect(out).toContain("No check finished in 24 h");
  });

  test("no git words render, not even in a title or label", () => {
    const out = kpiRowFor({ landedHours: hours(1), landed: 1, live: null, builders: { running: 2, slots: 4 }, medianCheckMs: 1000 }, null).toString();
    expect(out).not.toMatch(/commit|merge|branch|repositor|pull request|checks (passed|failed)/i);
  });

  test("the sparkline has one point per hour, oldest first", () => {
    const svg = sparkline(hours(4)).toString();
    const pts = /points="([^"]+)"/.exec(svg)![1]!.split(" ");
    expect(pts).toHaveLength(24);
    expect(pts[20]!.endsWith(",2.0")).toBe(true); // hour 3 ago is index 20, at the top
  });

  test("the live tile is the running commit, the same as /releases", () => {
    const prev = process.env["FORGE_COMMIT"];
    process.env["FORGE_COMMIT"] = "1234567abcdef";
    try {
      expect(liveNow()?.sha).toBe(running().commit!);
      expect(liveNow()?.sha).toBe("1234567abcdef");
    } finally {
      if (prev === undefined) delete process.env["FORGE_COMMIT"];
      else process.env["FORGE_COMMIT"] = prev;
    }
  });

  test("a truncated note carries its whole text as a title", () => {
    const out = kpiRowFor({ landedHours: hours(0), landed: 0, live: null, builders: { running: 2, slots: 4 }, medianCheckMs: null }, null).toString();
    expect(out).toContain('title="No check finished in 24 h"');
  });

  test("the note wraps into two reserved lines instead of cutting off on a phone", () => {
    const rule = (sel: string) => new RegExp(`\\${sel} \\{([^}]*)\\}`).exec(feedCss)![1]!;
    expect(rule(".kpi-note")).not.toContain("nowrap");
    expect(rule(".kpi-note")).toContain("line-height: 20px");
    expect(rule(".kpi-note")).toContain("line-clamp: 2");
    expect(rule(".kpi")).toContain("grid-template-rows: 20px 32px 40px 24px");
  });

  test("the builders tile says running of slots, titles it, and links to the crew", () => {
    const out = kpiRowFor({ landedHours: hours(0), landed: 0, live: null, medianCheckMs: null, builders: { running: 2, slots: 4 } }, null).toString();
    expect(out).toContain('href="/settings/crew"');
    expect(out).toContain('class="kpi-value num" title="2 of 4">2 of 4<');
    expect(out).toContain('title="Crew builders running now, of 4 slots"');
    expect(out).toContain('aria-label="Builders running: 2 of 4, Crew builders running now, of 4 slots"');
  });

  test("with no slots set the builders tile shows a dash and says so", () => {
    const out = kpiRowFor({ landedHours: hours(0), landed: 0, live: null, medianCheckMs: null, builders: { running: 0, slots: 0 } }, null).toString();
    expect(out).toContain('class="kpi-value num" title="—">—<');
    expect(out).toContain('title="No slots set">No slots set<');
    expect(out).not.toContain("0 of 0");
  });

  test("the builders note does not repeat the value", () => {
    const out = kpiRowFor({ landedHours: hours(0), landed: 0, live: null, medianCheckMs: null, builders: { running: 2, slots: 4 } }, null).toString();
    expect(out).toContain(">running now<");
  });

  test("check time reads as a person would", () => {
    expect(checkTime(null)).toBe("—");
    expect(checkTime(45_000)).toBe("45s");
    expect(checkTime(3_720_000)).toBe("1h 02m");
  });
});

describe("the builders figure from the database", () => {
  test("counts running agent runs against the autonomous repositories' slots", async () => {
    const { Database } = await import("bun:sqlite");
    const db = new Database(":memory:");
    db.run("CREATE TABLE repo (autonomy TEXT, autonomy_slots INTEGER, default_branch TEXT, id TEXT)");
    db.run("CREATE TABLE run (id TEXT, kind TEXT, state TEXT, started_at TEXT, finished_at TEXT, serving_at TEXT, env TEXT, commit_oid TEXT)");
    db.run("CREATE TABLE pull (merged_at TEXT, merged_oid TEXT, base_oid TEXT, base_branch TEXT, issue_id TEXT)");
    db.run("CREATE TABLE issue (id TEXT, repo_id TEXT)");
    db.run("INSERT INTO repo VALUES ('autonomous', 3, 'main', 'a'), ('autonomous', 1, 'main', 'b'), ('off', 8, 'main', 'c')");
    db.run("INSERT INTO run (id, kind, state) VALUES ('1','agent','running'), ('2','agent','running'), ('3','agent','queued'), ('4','check','running')");
    const { readKpis } = await import("../src/flow/kpis.ts");
    expect(readKpis(db, new Date()).builders).toEqual({ running: 2, slots: 4 });
  });
});

describe("the terminal's figures", () => {
  const k = { landedHours: hours(6), landed: 6, live: { sha: "abcdef0123456", at: new Date().toISOString() }, builders: { running: 2, slots: 4 }, medianCheckMs: 185_000 };
  test("the same four figures in the same words", () => {
    const lines = kpiLines(k, { sha: "abcdef0123456", since: "5m ago" });
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe("Builders running 2 of 4");
    expect(kpiLines({ ...k, builders: { running: 0, slots: 0 } }, null)[3]).toBe("Builders running —, no slots set");
    expect(lines[0]).toContain("Shipped per hour 0.3");
    expect(lines[0]).toContain("6 changes in 24 h");
    expect(lines[1]).toContain("Live version abcdef0");
    expect(lines[2]).toBe("Median check time 3m 05s");
    expect(lines.join(" ")).not.toMatch(/commit|merge|branch|repositor|pull request/i);
  });
  test("the block sparkline has 24 cells, the busy hour tallest", () => {
    const s = sparkText(hours(4));
    expect([...s]).toHaveLength(24);
    expect(s[20]).toBe("█");
  });
});
