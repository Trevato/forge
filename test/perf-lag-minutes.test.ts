/**
 * The last 20 one-minute worst loop-lag readings (#11220): the ring keeps 20,
 * the oldest falls off, the over-the-bar count is right, each minute is named
 * by the worst stall blamed in it, /system draws them against the 100 ms bar
 * and the MCP `system` tool answers the same readings.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createLagMinutes, LAG_BAR_MS, LAG_MINUTE_MS, LAG_READINGS, overBar } from "../src/perf/lag_minutes.ts";
import { lagMinutes } from "../src/perf/live.ts";
import { lagSection } from "../src/web/pages/system.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const MIN = LAG_MINUTE_MS;

describe("the ring of minutes", () => {
  test("is 20 minutes against a 100 ms bar", () => {
    expect(LAG_READINGS).toBe(20);
    expect(LAG_BAR_MS).toBe(100);
    expect(MIN).toBe(60_000);
  });

  test("a minute's reading is its worst wake, closed by the first wake of the next", () => {
    const ring = createLagMinutes(() => null, () => 0);
    ring.note(3, 0);
    ring.note(40, 10_000);
    ring.note(7, 59_999);
    expect(ring.readings()).toEqual([]); // the open minute is not a reading
    ring.note(1, MIN);
    expect(ring.readings().map((r) => r.ms)).toEqual([40]);
  });

  test("filled past 20, the oldest falls off and the over count is right", () => {
    const ring = createLagMinutes();
    // 25 minutes, minute k's worst k * 10 ms: 0, 10, …, 240. The 26th wake closes the 25th.
    for (let k = 0; k <= 25; k++) {
      ring.note(k * 10, k * MIN + 5);
      ring.note(k * 5, k * MIN + 30_000);
    }
    const rows = ring.readings();
    expect(rows).toHaveLength(20);
    // Minutes 0–4 fell off; 5–24 remain, oldest first.
    expect(rows.map((r) => r.ms)).toEqual(Array.from({ length: 20 }, (_, i) => (i + 5) * 10));
    // Over 100 ms (strictly): 110, 120, …, 240 → minutes 11–24, 14 of them. 100 itself holds the bar.
    expect(overBar(rows)).toBe(14);
    expect(rows.some((r) => r.ms === 100)).toBe(true);
  });

  test("each minute is named by the blame for its own span, read once as it closes", () => {
    const asked: [number, number][] = [];
    const ring = createLagMinutes((to, span) => {
      asked.push([to, span]);
      return to === 2 * MIN ? "job:snapshot" : null;
    }, () => 1_000_000);
    ring.note(10, 0);
    ring.note(250, MIN + 10);
    for (let t = MIN + 50; t < 2 * MIN; t += 50) ring.note(1, t); // ticks inside a minute ask nothing
    ring.note(5, 2 * MIN + 20);
    expect(asked).toEqual([[MIN, MIN], [2 * MIN, MIN]]);
    const rows = ring.readings();
    expect(rows.map((r) => r.what)).toEqual([null, "job:snapshot"]);
    // A minute began `wall − (mono − start)`: closed at mono 2·MIN+20 when the wall read 1,000,000.
    expect(rows[1]!.at).toBe(1_000_000 - (2 * MIN + 20 - MIN));
  });

  test("a bad reading or a clock stepping back changes nothing", () => {
    const ring = createLagMinutes();
    ring.note(30, 5 * MIN);
    ring.note(Number.NaN, 5 * MIN + 1);
    ring.note(-4, 5 * MIN + 2);
    ring.note(900, 4 * MIN);
    ring.note(0, 6 * MIN);
    expect(ring.readings().map((r) => r.ms)).toEqual([30]);
    ring.clear();
    expect(ring.readings()).toEqual([]);
  });
});

describe("drawn on /system", () => {
  test("the count over the bar, and each minute over it named", () => {
    const rows = [
      { at: Date.UTC(2026, 10, 11, 9, 0), ms: 12, what: null },
      { at: Date.UTC(2026, 10, 11, 9, 1), ms: 340, what: "/<owner>/<repo>/pulls" },
      { at: Date.UTC(2026, 10, 11, 9, 2), ms: 140, what: null },
    ];
    const text = lagSection(rows).text;
    expect(text).toContain('data-readings="3"');
    expect(text).toContain('data-over="2"');
    expect(text).toContain("2 of 3 over 100 ms");
    expect(text).toContain("/&lt;owner&gt;/&lt;repo&gt;/pulls"); // escaped
    expect(text).toContain("not named");
    // One table: every minute a row, the two over the bar marked, no second view of them.
    expect(text.match(/<tr data-lag-over=/g)?.length).toBe(3);
    expect(text.match(/data-lag-over="1"/g)?.length).toBe(2);
    expect(text).not.toContain("<svg");
    expect(lagSection(rows.slice(0, 1)).text).toContain("all 1 under 100 ms");
    expect(lagSection([]).text).toContain("No full minute measured yet.");
  });
});

describe("the MCP system tool", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let token = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-lag-minutes-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@x.test", password: "correct horse battery 9", isAdmin: true });
    if (!u.ok) throw new Error("alice");
    token = createToken(app.db, u.value.id, "t", "admin").token;
  }, 30_000);

  afterAll(async () => {
    lagMinutes.clear();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("answers the same readings as {at, ms, what}, with the bar and the count over it", async () => {
    lagMinutes.clear();
    const base = 1_000 * MIN;
    lagMinutes.note(20, base);
    lagMinutes.note(180.04, base + MIN);
    lagMinutes.note(1, base + 2 * MIN);
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "system", arguments: {} } }),
    });
    const out = JSON.parse(((await res.json()) as any).result.content[0].text);
    expect(out.barMs).toBe(100);
    expect(out.over).toBe(1);
    expect(out.readings.map((r: any) => r.ms)).toEqual([20, 180]);
    expect(out.readings.map((r: any) => r.what)).toEqual([null, null]);
    for (const r of out.readings) expect(new Date(r.at).toISOString()).toBe(r.at);
  });
});
