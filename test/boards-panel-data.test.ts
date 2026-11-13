/**
 * A panel's data as JSON and CSV (#3691): bucketed in SQL to the step asked
 * for, or one the panel picks, and never cut short — a day of per-minute
 * points reaches now, where the old 1000-row cap stopped hours early.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBoard } from "../src/actions/boards.ts";
import { createApp } from "../src/app.ts";
import { panelData, parseStep, parseWindow, rowsCsv, stepFor, TARGET_POINTS, type runFor } from "../src/boards/panel_data.ts";
import { MAX_POINTS, oldestTime, runQuery } from "../src/boards/query.ts";
import type { Board, Panel } from "../src/boards/store.ts";
import { components } from "../src/web/style/components.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";

let dir: string;
let app: ReturnType<typeof createApp>;
let servers: Awaited<ReturnType<typeof serve>>;
const tok: Record<string, string> = {};
/** The newest minute with a point: one per minute for the 24 h before it. */
const LAST = Math.floor(Date.now() / 60_000) * 60_000;
const minute = (t: number) => new Date(t).toISOString().slice(0, 16) + ":00Z";
const CPU = { source: "machine", aggregate: "avg", column: "cpu_cores", groupBy: { bucket: "minute" }, filter: [{ column: "target", op: "eq", value: "forge" }] };
const BOARD: Board = {
  title: "Usage test",
  range: "24h",
  refresh: "off",
  panels: [
    { title: "Pod CPU", chart: "line", query: CPU, w: 2, h: 1 },
    { title: "By target", chart: "bar", query: { source: "machine", aggregate: "count", groupBy: "target" }, w: 1, h: 1 },
  ],
};
type Out = { board: string; panel: number; title: string; step: number | null; rows: { group: string; value: number }[] };

const api = (path: string, who = tok.admin) =>
  fetch(servers.url + path, { headers: who ? { authorization: `Bearer ${who}` } : {} });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-panel-data-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, adminIfFirst?: boolean) => {
    const r = await createUser(app.db, {
      origin: "seed", trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", ...(adminIfFirst ? { adminIfFirst } : {}),
    });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  const alice = await mk("alice", true);
  const bob = await mk("bob");
  tok.admin = createToken(app.db, alice.id, "t", "admin").token;
  tok.bob = createToken(app.db, bob.id, "t", "admin").token;
  const ins = app.db.prepare("INSERT INTO machine_sample (at, step, target, cpu_cores) VALUES (?, 15, ?, ?)");
  app.db.transaction(() => {
    for (let i = 0; i < 1440; i++) ins.run(new Date(LAST - i * 60_000).toISOString(), "forge", i % 7);
    ins.run(new Date(LAST).toISOString(), "=HYPERLINK(\"x\")", 1);
  })();
  const made = await writeBoard(app, alice, "usage-test", BOARD);
  if (!made.ok) throw new Error(JSON.stringify(made.error));
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("runQuery with a step", () => {
  test("a day of per-minute buckets is every minute, up to the newest, not the first 1000", () => {
    const a = runQuery(app.db, CPU, { repoIds: "all" });
    if (!a.ok) throw new Error(a.error);
    expect(a.rows.length).toBe(1440);
    expect(a.rows.at(-1)!.group).toBe(minute(LAST));
  });

  test("a step floors each point to its bucket in UTC; minute, hour and day read as before", () => {
    const at = (q: Record<string, unknown>) => {
      const a = runQuery(app.db, { ...CPU, ...q }, { repoIds: "all" });
      return a.ok ? a.rows.at(-1)!.group : a.error;
    };
    const five = Math.floor(LAST / 300_000) * 300_000;
    expect(at({ step: 300 })).toBe(minute(five));
    expect(at({ groupBy: { bucket: "hour" } })).toBe(new Date(Math.floor(LAST / 3_600_000) * 3_600_000).toISOString().slice(0, 13) + ":00:00Z");
    expect(at({ groupBy: { bucket: "day" } })).toBe(new Date(LAST).toISOString().slice(0, 10) + "T00:00:00Z");
  });

  test("a bad step, or a step without a time bucket, is refused by name", () => {
    for (const step of [0, -60, 1.5, "60", 31_536_001]) {
      expect(runQuery(app.db, { ...CPU, step }, { repoIds: "all" })).toMatchObject({ ok: false, error: expect.stringContaining("step") });
    }
    expect(runQuery(app.db, { source: "machine", aggregate: "count", groupBy: "target", step: 60 }, { repoIds: "all" }))
      .toEqual({ ok: false, error: "step needs a group by a time bucket" });
  });
});

describe("panelData", () => {
  test("a 24 h board picks a 5-minute step: 288 buckets or one more for the partial edge, the last one now", () => {
    const d = panelData(app.db, BOARD, BOARD.panels[0]!, {}, LAST + 30_000);
    if (!d.ok) throw new Error(d.error);
    expect(d.step).toBe(300);
    expect(d.rows.length).toBeGreaterThanOrEqual(288);
    expect(d.rows.length).toBeLessThanOrEqual(289);
    expect(d.rows.at(-1)!.group).toBe(minute(Math.floor(LAST / 300_000) * 300_000));
  });

  test("a board whose range is all fits the step to the span from the panel's oldest row, not its bucket", () => {
    const all: Board = { ...BOARD, range: "all" };
    const d = panelData(app.db, all, all.panels[0]!, {}, LAST + 30_000);
    if (!d.ok) throw new Error(d.error);
    expect(d).toMatchObject({ from: null, step: 300 });
    expect(d.rows.length).toBeLessThanOrEqual(TARGET_POINTS + 1);
    // The oldest row is the query's own: its filters and window count, and no rows means no span to fit.
    expect(oldestTime(app.db, CPU, { repoIds: "all" })).toBe(new Date(LAST - 1439 * 60_000).toISOString());
    const other = { ...CPU, filter: [{ column: "target", op: "eq", value: '=HYPERLINK("x")' }] };
    expect(oldestTime(app.db, other, { repoIds: "all" })).toBe(new Date(LAST).toISOString());
    expect(oldestTime(app.db, { ...CPU, to: "2000-01-01T00:00:00Z" }, { repoIds: "all" })).toBeNull();
    expect(oldestTime(app.db, { source: "nope" }, { repoIds: "all" })).toBeNull();
    expect(oldestTime(app.db, CPU, { repoIds: [] })).toBeNull();
    const empty: Panel = { ...all.panels[0]!, query: { ...CPU, to: "2000-01-01T00:00:00Z" } };
    expect(panelData(app.db, all, empty, {}, LAST)).toMatchObject({ ok: true, rows: [], step: 60 });
  });

  test("an answer too large for its step is asked again coarser, never cut", () => {
    const steps: unknown[] = [];
    const run: typeof runFor = (_db, _chart, q) => {
      steps.push(q.step);
      return (q.step as number) < 900 ? { ok: false, error: "too many", tooMany: true } : { ok: true, rows: [] };
    };
    expect(panelData(app.db, BOARD, BOARD.panels[0]!, {}, LAST, run)).toMatchObject({ ok: true, step: 900 });
    expect(steps).toEqual([300, 600, 900]);
    steps.length = 0;
    expect(panelData(app.db, BOARD, BOARD.panels[0]!, { step: 60 }, LAST, run)).toEqual({ ok: false, error: "too many" });
    expect(steps).toEqual([60]);
  });

  test("a step fits the span; a step is read as seconds or with a unit", () => {
    expect([stepFor(3_600_000, 60), stepFor(86_400_000, 60), stepFor(604_800_000, 60), stepFor(2_592_000_000, 60)]).toEqual([60, 300, 1800, 7200]);
    expect(stepFor(86_400_000, 86_400)).toBe(86_400);
    expect(["300", "15s", "5m", "1h", "1d"].map(parseStep)).toEqual([300, 15, 300, 3600, 86_400]);
    for (const bad of ["", "0", "5x", "-5m", "1.5h", "366d", "5 m"]) expect(parseStep(bad)).toBeUndefined();
    expect(parseWindow(new URLSearchParams("from=2026-10-20T00:00:00Z&to=2026-10-19T00:00:00Z"))).toEqual({ ok: false, error: "from must be before to" });
    expect(parseWindow(new URLSearchParams("from=yesterday")).ok).toBe(false);
  });

  test("CSV quotes what needs it and never starts a text cell with a formula", () => {
    expect(rowsCsv([{ group: "a,b", value: -1.5 }, { group: null, value: null }])).toBe('group,value\r\n"a,b",-1.5\r\n,\r\n');
    expect(rowsCsv([{ group: "=1+1", series: '"q"', value: 2 }])).toBe(`group,series,value\r\n'=1+1,"""q""",2\r\n`);
  });
});

describe("GET /api/v1/boards/:slug/panels/:id", () => {
  test("24 h of 1-minute data at the panel's own step reaches now", async () => {
    const res = await api("/api/v1/boards/usage-test/panels/0");
    expect(res.status).toBe(200);
    const out = (await res.json()) as Out;
    expect([out.board, out.panel, out.title, out.step]).toEqual(["usage-test", 0, "Pod CPU", 300]);
    // The seed minute's bucket, or a later one if the clock crossed a 5-minute mark since the file loaded.
    const seeded = Math.floor(LAST / 300_000) * 300_000;
    const nowMark = Math.floor(Date.now() / 300_000) * 300_000;
    expect([minute(seeded), minute(nowMark)]).toContain(out.rows.at(-1)!.group);
  });

  test("step=1m over 24 h is all 1440 minutes; step=5m over an aligned day is 288 buckets", async () => {
    // From the oldest point, not the clock: a minute turning mid-test would drop it from a now-based window.
    const oldest = new Date(LAST - 1439 * 60_000).toISOString();
    const all = (await (await api(`/api/v1/boards/usage-test/panels/0?step=1m&from=${oldest}`)).json()) as Out;
    expect(all.rows.length).toBe(1440);
    expect(all.rows.at(-1)!.group).toBe(minute(LAST));
    // The first 5-minute mark after LAST: the day before it starts within the data and its last bucket holds LAST,
    // whatever minute the clock is on (ending at the mark before LAST could start a minute before the oldest point).
    const to = Math.floor(LAST / 300_000) * 300_000 + 300_000;
    const q = `from=${new Date(to - 86_400_000).toISOString()}&to=${new Date(to).toISOString()}&step=5m`;
    const five = (await (await api(`/api/v1/boards/usage-test/panels/0?${q}`)).json()) as Out;
    expect(five.step).toBe(300);
    expect(five.rows.length).toBe(288);
  });

  test("the CSV is the JSON's rows", async () => {
    // One fixed window for both: a now-based one could lose its oldest point between the two reads.
    const q = `step=1h&from=${new Date(LAST - 1439 * 60_000).toISOString()}`;
    const json = (await (await api(`/api/v1/boards/usage-test/panels/0?${q}`)).json()) as Out;
    const res = await api(`/api/v1/boards/usage-test/panels/0?${q}&format=csv`);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    const [head, ...lines] = (await res.text()).trimEnd().split("\r\n");
    expect(head).toBe("group,value");
    expect(lines.map((l) => l.split(","))).toEqual(json.rows.map((r) => [r.group, String(r.value)]));
    expect(lines.length).toBeGreaterThanOrEqual(24);
  });

  test("a panel not grouped by time ignores the step; a text cell is never a formula", async () => {
    // The day of points is pinned, so a minute turning over mid-run can't drop the oldest one.
    const day = `from=${new Date(LAST - 86_400_000).toISOString()}`;
    const out = (await (await api(`/api/v1/boards/usage-test/panels/1?step=5m&${day}`)).json()) as Out;
    expect(out.step).toBeNull();
    expect(out.rows.map((r) => r.group)).toEqual(['=HYPERLINK("x")', "forge"]);
    const csv = await (await api(`/api/v1/boards/usage-test/panels/1?format=csv&${day}`)).text();
    expect(csv).toBe(`group,value\r\n"'=HYPERLINK(""x"")",1\r\nforge,1440\r\n`);
  });

  test("a bad window or format is 422; a missing panel or board is 404; a non-admin 403, signed out 401", async () => {
    expect((await api("/api/v1/boards/usage-test/panels/0?step=5x")).status).toBe(422);
    expect((await api("/api/v1/boards/usage-test/panels/0?from=soon")).status).toBe(422);
    expect((await api("/api/v1/boards/usage-test/panels/0?format=xml")).status).toBe(422);
    expect((await api("/api/v1/boards/usage-test/panels/2")).status).toBe(404);
    expect((await api("/api/v1/boards/usage-test/panels/x")).status).toBe(404);
    expect((await api("/api/v1/boards/nope/panels/0")).status).toBe(404);
    expect((await api("/api/v1/boards/usage-test/panels/0", tok.bob)).status).toBe(403);
    expect((await api("/api/v1/boards/usage-test/panels/0", "")).status).toBe(401);
  });

  test("the board page links each panel's data as JSON and as a CSV download, plain links that need no script", async () => {
    const page = await (await api("/boards/usage-test")).text();
    for (const i of ["0", "1"]) {
      expect(page).toContain(`href="/api/v1/boards/usage-test/panels/${i}"`);
      expect(page).toContain(`href="/api/v1/boards/usage-test/panels/${i}?format=csv" download="usage-test-${i}.csv"`);
    }
    // A panel's links sit under its chart, each a 44px target (docs/DESIGN.md).
    expect(page.match(/<p class="bp-foot card-links"><a href="\/boards\/data\?[^"]*" aria-label="[^"]*: explore">Explore<\/a>\s*<a href="\/api\/v1\/boards\/usage-test\/panels\/\d"/g)?.length).toBe(2);
    expect(components).toMatch(/\.bp-foot > a \{[^}]*min-height: 44px[^}]*\}/);
    // The link answers what it names, to the same admin.
    expect((await api("/api/v1/boards/usage-test/panels/1?format=csv")).headers.get("content-type")).toBe("text/csv; charset=utf-8");
  });

  test("a step finer than the cap allows is refused, not cut", async () => {
    const ins = app.db.prepare("INSERT INTO machine_sample (at, step, target, cpu_cores) VALUES (?, 15, 'forge', 1)");
    app.db.transaction(() => {
      for (let i = 1; i <= MAX_POINTS; i++) ins.run(new Date(LAST - 86_400_000 - i * 1000).toISOString());
    })();
    const res = await api(`/api/v1/boards/usage-test/panels/0?step=1s&from=${new Date(LAST - 2 * 86_400_000).toISOString()}`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain("coarser step");
    app.db.run("DELETE FROM machine_sample WHERE at < ?", [new Date(LAST - 86_400_000).toISOString()]);
  });
});
