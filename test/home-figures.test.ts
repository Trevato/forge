/**
 * The home's figures: one formatter for every number, one card and one chart for
 * every figure, the unit always beside the value, and the data from the lanes'
 * picture (the worker's slow part), never from a request.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { ageWords, count, duration, money, pageTime, share } from "../src/flow/figure_format.ts";
import { lanePicture } from "../src/flow/lanes.ts";
import { waitingWords } from "../src/flow/kpi_words.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { cards, chart } from "../src/web/pages/home_figures.ts";
import { seedHomeFlow, type HomeFlowSeed } from "./helpers/home-flow-seed.ts";

describe("one helper writes every number", () => {
  test("counts, spans, money, shares and page times", () => {
    expect(count(1234)).toBe("1,234");
    expect(count(0)).toBe("0");
    expect(duration(45 * 60_000)).toBe("45m");
    expect(duration(3 * 86_400_000 + 4 * 3_600_000)).toBe("3d 4h");
    expect(duration(250)).toBe("250ms");
    expect(money(12.4)).toBe("$12.40");
    expect(money(1910.2)).toBe("$1,910");
    expect(share(0.364)).toBe("36%");
    expect(pageTime(1130)).toBe("1.1s");
    expect(pageTime(900)).toBe("900ms");
  });

  test("an age in a sentence is in the largest sensible unit, never hours past two days", () => {
    expect(ageWords(30_000)).toBe("under a minute");
    expect(ageWords(5 * 60_000)).toBe("5 minutes");
    expect(ageWords(3 * 3_600_000)).toBe("3 hours");
    expect(ageWords(11 * 86_400_000 + 6 * 3_600_000)).toBe("11 days");
    expect(ageWords(270 * 3_600_000)).toBe("11 days");
    expect(ageWords(90 * 86_400_000)).toBe("3 months");
    expect(waitingWords(38, new Date(Date.now() - 270 * 3_600_000).toISOString(), new Date())).toBe("38 waiting on you, oldest 11 days");
    expect(waitingWords(0, null, new Date())).toBeNull();
  });
});

describe("one chart", () => {
  test("a line over a faint area, the same box for every series, a gap breaking the line, and nothing for no data", () => {
    const svg = String(chart([1, 2, 3], "Three days"));
    expect(svg).toContain('viewBox="0 0 120 32"');
    expect(svg).toContain('aria-label="Three days"');
    expect(svg).toContain("fg-area");
    expect(svg).toContain("fg-line");
    const broken = String(chart([1, 2, null, 4, 5], "Gap"));
    expect(broken.match(/<polyline/g)?.length).toBe(2);
    expect(chart([null, null], "None")).toBeNull();
    expect(String(chart([5], "One"))).toContain("fg-dot");
  });
});

describe("a card says its unit", () => {
  const figures = {
    visitors: { today: 12, week: 147, days: Array.from({ length: 30 }, (_, i) => i), accountsToday: 1, accounts: 4 },
    speed: { load: 1130, lcp: 2300, inp: 201 },
    shipped: { days: [0, 3, 8, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 2], total: 14 },
    spend: { todayUsd: 39, ceilingUsd: 50, days: Array.from({ length: 14 }, () => 20), totalUsd: 280 },
    checks: { medianMs: 8 * 60_000, days: Array.from({ length: 14 }, (_, i) => (i === 3 ? null : 5 * 60_000)) },
    bugs: { open: 3, overdue: 1 },
    backup: { at: null, state: null, note: "" },
  } as const;
  const now = Date.parse("2026-11-13T12:00:00Z");

  test("every card has a value with its unit beside it, and a number is never bare", () => {
    const all = cards(figures, now);
    expect(all.map((c) => c.label)).toEqual(["Shipped", "Visitors", "Crew spend", "Check time", "Page speed", "Open bugs", "Off-box backup"]);
    for (const c of all) {
      expect(c.unit.length).toBeGreaterThan(0);
      expect(c.value).not.toMatch(/^\d+\.\d{3,}/);
    }
    const spend = all.find((c) => c.label === "Crew spend")!;
    expect(spend.value).toBe("$39.00");
    expect(spend.note).toBe("78% of the $50.00 daily ceiling");
    expect(spend.tone).toBeUndefined();
    expect(all.find((c) => c.label === "Open bugs")?.tone).toBe("attn");
    expect(all.find((c) => c.label === "Check time")?.value).toBe("8m");
    expect(all.find((c) => c.label === "Page speed")?.note).toBe("LCP 2.3s · INP 201ms");
  });

  test("no backup is said as that, not as safe", () => {
    const backup = cards(figures, now).find((c) => c.label === "Off-box backup")!;
    expect(backup.value).toBe("—");
    expect(backup.note).not.toContain("Safe");
  });

  test("near the ceiling, the spend is flagged", () => {
    const hot = cards({ ...figures, spend: { ...figures.spend, todayUsd: 47 } }, now).find((c) => c.label === "Crew spend")!;
    expect(hot.tone).toBe("attn");
  });
});

describe("the figures come from the picture", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let seed: HomeFlowSeed;
  let owner = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-home-figures-"));
    app = createApp({ dataDir, port: 0 });
    seed = await seedHomeFlow(app);
    servers = await serve(app);
    owner = `forge_session=${createSession(app.db, seed.owner.id).token}`;
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the worker's picture carries them, and the home draws one section of cards that is the owner's alone", async () => {
    const picture = await lanePicture(app.db, { dataDir, ceilingUsd: null, viewer: seed.owner.id });
    expect(picture?.figures?.shipped.days.length).toBe(14);
    expect(picture?.figures?.shipped.total).toBeGreaterThan(0);
    const html = await (await fetch(`${servers.url}/`, { headers: { cookie: owner } })).text();
    expect(html).toContain('id="hf-figures"');
    expect(html.match(/class="fg-card/g)?.length).toBe(7);
    expect(html).not.toContain("Safe off the machine");
    const body = await fetch(`${servers.url}/live/figures`, { headers: { cookie: owner } });
    expect(body.status).toBe(200);
    expect((await body.text()).match(/class="fg-card/g)?.length).toBe(7);
    expect((await fetch(`${servers.url}/live/figures`)).status).toBeGreaterThanOrEqual(400);
  });
});
