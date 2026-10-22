/**
 * The fleet graph: a selection's spend and runs per UTC hour (24 h) and day
 * (14 d). The buckets are checked against a hand count, the bars against
 * the scale stated in `web/fleet-graph.ts`, and the selection against
 * write access — a reader never sees another owner's spend, and a name they
 * cannot see is counted with the missing ones, never told apart.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FLEET_GRAPH_MAX_REPOS,
  fleetSelection,
  readFleetGraph,
  windowBounds,
} from "../src/actions/fleet-graph.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createRun } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { recordUsage, usageBuckets, type UsageOutcome } from "../src/core/usage.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import {
  FLEET_GRAPH_EVENTS,
  fleetGraphClientJs,
  niceCeiling,
  windowSvg,
} from "../src/web/fleet-graph.ts";
import { fleetGraphCsvText } from "../src/web/pages/fleet-graph.ts";
import { promote } from "./helpers/members.ts";

describe("the windows", () => {
  const now = new Date("2026-10-02T14:37:12.345Z");

  test("24 h is 24 whole UTC hours, the current one last and still filling", () => {
    const w = windowBounds("24h", now);
    expect(w.since.toISOString()).toBe("2026-10-01T15:00:00.000Z");
    expect(w.until.toISOString()).toBe("2026-10-02T15:00:00.000Z");
    expect(w.starts).toHaveLength(24);
    expect(w.starts[23]!.toISOString()).toBe("2026-10-02T14:00:00.000Z");
  });

  test("14 d is 14 whole UTC days, today last", () => {
    const w = windowBounds("14d", now);
    // 2026-10-02 minus 13 days is 2026-09-19.
    expect(w.since.toISOString()).toBe("2026-09-19T00:00:00.000Z");
    expect(w.until.toISOString()).toBe("2026-10-03T00:00:00.000Z");
    expect(w.starts).toHaveLength(14);
  });
});

describe("the scale", () => {
  test("the top tick is the smallest 1, 2, 2.5 or 5 × 10ⁿ at or above", () => {
    expect(niceCeiling(3, 1)).toBe(5);
    expect(niceCeiling(2.1, 1)).toBe(2.5);
    expect(niceCeiling(0.42, 1)).toBeCloseTo(0.5, 12);
    expect(niceCeiling(10, 1)).toBe(10);
    expect(niceCeiling(11, 1)).toBe(20);
    expect(niceCeiling(0, 1)).toBe(1);
  });
});

describe("the selection", () => {
  test("absent is the default; lists split on spaces and commas; names dedupe", () => {
    expect(fleetSelection([])).toEqual({ ok: true, value: null });
    expect(fleetSelection([""])).toEqual({ ok: true, value: null });
    expect(fleetSelection(["alice/one, alice/two", "Alice/One"])).toEqual({
      ok: true,
      value: ["alice/one", "alice/two"],
    });
  });

  test("anything not owner/name, or too many, is refused rather than trimmed", () => {
    expect(fleetSelection(["../etc"]).ok).toBe(false);
    expect(fleetSelection(["alice/<b>"]).ok).toBe(false);
    expect(fleetSelection(["alice"]).ok).toBe(false);
    const many = Array.from(
      { length: FLEET_GRAPH_MAX_REPOS + 1 },
      (_, i) => `a/r${i}`,
    );
    expect(fleetSelection(many).ok).toBe(false);
  });
});

describe("the graph", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let bob: User;
  let servers: Servers;
  const ids: Record<string, string> = {};
  const now = new Date("2026-10-02T14:37:12.345Z");

  const spend = (
    repo: string,
    at: string,
    usd: number,
    outcome: UsageOutcome = "ok",
  ) =>
    recordUsage(app.db, {
      runId: createRun(app.db, { repoId: ids[repo]!, kind: "agent" }).id,
      repoId: ids[repo]!,
      issueId: null,
      agentId: null,
      subscriptionId: null,
      tokensIn: 1000,
      tokensOut: 100,
      costUsd: usd,
      wallMs: 60_000,
      outcome,
      at,
    });

  const signIn = async (username: string, password: string) =>
    (
      (
        await fetch(`${servers.url}/signin`, {
          method: "POST",
          body: new URLSearchParams({ username, password }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-fleet-graph-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    // The first account is the site admin, who may write everything; the
    // owners below are ordinary accounts, so their spend is theirs alone.
    const root = await createUser(app.db, { origin: "seed", trusted: true,
      username: "root",
      email: "root@forge.local",
      password: "a-root-passphrase",
      adminIfFirst: true,
      // A fixture that names its admin "root" on purpose.
      allowReserved: true,
    });
    if (!root.ok) throw new Error("root");
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
    });
    const b = await createUser(app.db, { origin: "seed", trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "another-good-passphrase",
    });
    if (!a.ok || !b.ok) throw new Error("users");
    alice = a.value;
    bob = b.value;
    promote(app.db, alice, bob);
    for (const name of ["one", "two"]) {
      const r = await createRepo(app, alice, { name, visibility: "private" });
      if (!r.ok) throw new Error("repo");
      ids[name] = r.value.id;
    }
    // Bob's repository is public: anyone may read it, only Bob may see its spend.
    const three = await createRepo(app, bob, { name: "three", visibility: "public" });
    if (!three.ok) throw new Error("repo");
    ids["three"] = three.value.id;

    spend("one", "2026-10-02T14:05:00.000Z", 1.25);
    spend("one", "2026-10-02T14:50:00.000Z", 0.75, "failed"); // after `now`'s minute, same hour
    spend("two", "2026-10-02T13:10:00.000Z", 2);
    spend("one", "2026-09-25T10:00:00.000Z", 4); // in 14 d, not in 24 h
    spend("one", "2026-09-18T23:59:59.999Z", 100); // a millisecond before the 14 d window
    spend("three", "2026-10-02T14:10:00.000Z", 9); // Bob's
  });

  afterAll(async () => {
    servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the ledger buckets by the exact UTC hour and day prefix", () => {
    const rows = usageBuckets(
      app.db,
      [ids["one"]!],
      "2026-10-02T00:00:00.000Z",
      "hour",
    );
    expect(rows).toEqual([
      {
        repoId: ids["one"]!,
        bucket: "2026-10-02T14",
        runs: 2,
        failed: 1,
        costUsd: 2,
      },
    ]);
  });

  test("by default: what the viewer may write that spent, summed by hand", () => {
    const g = readFleetGraph(app, alice, null, now);
    expect(g.series.map((s) => s.label)).toEqual(["alice/one", "alice/two"]);
    expect(g.hidden).toBe(0);
    const [day, fortnight] = g.windows;
    // 14:00 holds one's two runs: $1.25 + $0.75 = $2.00, one failed.
    expect(day.buckets[23]!.start).toBe("2026-10-02T14:00:00.000Z");
    expect(day.buckets[23]!.costUsd).toEqual([2, 0]);
    expect(day.buckets[23]!.runs).toEqual([2, 0]);
    expect(day.buckets[23]!.failed).toEqual([1, 0]);
    expect(day.buckets[22]!.costUsd).toEqual([0, 2]);
    expect(day.totals.costUsd).toEqual([2, 2]);
    // 14 d: $2.00 today + $4.00 on 09-25 = $6.00; the $100 a millisecond
    // before the window is not in it.
    expect(fortnight.totals.costUsd).toEqual([6, 2]);
    expect(fortnight.buckets[6]!.start).toBe("2026-09-25T00:00:00.000Z");
    expect(fortnight.buckets[6]!.costUsd).toEqual([4, 0]);
    expect(fortnight.buckets[13]!.runs).toEqual([2, 1]);
    expect(g.repos.map((r) => [r.repo, r.fortnight.costUsd, r.day.runs])).toEqual([
      ["alice/one", 6, 2],
      ["alice/two", 2, 1],
    ]);
  });

  test("another owner's spend is never drawn, and a hidden name is not told from a missing one", () => {
    const g = readFleetGraph(
      app,
      alice,
      ["alice/one", "bob/three", "nobody/nothing"],
      now,
    );
    expect(g.repos.map((r) => r.repo)).toEqual(["alice/one"]);
    expect(g.hidden).toBe(2);
    // `asked` echoes the caller's own words; nothing drawn is Bob's.
    expect(JSON.stringify({ ...g, asked: [] })).not.toContain("three");
    const bobs = readFleetGraph(app, bob, null, now);
    expect(bobs.repos.map((r) => r.repo)).toEqual(["bob/three"]);
  });

  test("past eight repositories the smallest share one series", async () => {
    const names: string[] = [];
    for (let i = 0; i < 9; i++) {
      const r = await createRepo(app, alice, { name: `many${i}`, visibility: "private" });
      if (!r.ok) throw new Error("repo");
      ids[`many${i}`] = r.value.id;
      names.push(`alice/many${i}`);
      // many0 spends $9, many1 $8 … many8 $1.
      spend(`many${i}`, "2026-10-02T10:00:00.000Z", 9 - i);
    }
    const g = readFleetGraph(app, alice, names, now);
    expect(g.series).toHaveLength(8);
    expect(g.series[7]!.label).toBe("2 others");
    expect(g.series[7]!.repos).toEqual(["alice/many7", "alice/many8"]);
    // $2 + $1 folded together.
    expect(g.windows[0].totals.costUsd[7]).toBe(3);
    expect(g.repos).toHaveLength(9);
    expect(g.repos[8]!.series).toBe(7);
  });

  test("a bar's height is its value over the top tick times the panel height", () => {
    const g = readFleetGraph(app, alice, ["alice/one", "alice/two"], now);
    const svg = windowSvg(g, g.windows[0]).text;
    // Tallest spend stack is $2.00 → top tick 2; tallest runs stack is 2 → 2.
    expect(svg).toContain('data-spend-top="2"');
    expect(svg).toContain('data-runs-top="2"');
    const rect = (attr: string, bucket: string, series: number) =>
      svg.match(
        new RegExp(
          `<rect class="fg-s${series}" data-series="${series}" data-bucket="${bucket}" data-${attr}="[^"]*"[^>]*height="([^"]+)"`,
        ),
      )?.[1];
    // $2.00 / 2 × 120 px = 120 px; one run of two-tick 60 px panel = 30 px.
    expect(rect("spend", "2026-10-02T14:00:00.000Z", 0)).toBe("120");
    expect(rect("runs", "2026-10-02T14:00:00.000Z", 0)).toBe("60");
    expect(rect("runs", "2026-10-02T13:00:00.000Z", 1)).toBe("30");
    expect(svg).toContain("<title>alice/one · 2026-10-02 14:00 UTC · 2 runs, 1 failed</title>");
  });

  test("the table file has a row per window, bucket and series", () => {
    const g = readFleetGraph(app, alice, ["alice/one", "alice/two"], now);
    const lines = fleetGraphCsvText(g).trimEnd().split("\r\n");
    // Header + (24 + 14) buckets × 2 series.
    expect(lines).toHaveLength(1 + (24 + 14) * 2);
    expect(lines[0]).toBe("window,bucket_start_utc,series,runs,failed,cost_usd");
    expect(lines).toContain("24h,2026-10-02T14:00:00.000Z,alice/one,2,1,2.0000");
    expect(lines).toContain("14d,2026-09-25T00:00:00.000Z,alice/one,1,0,4.0000");
  });

  describe("over HTTP", () => {
    test("the page draws the selection and says what it assumes", async () => {
      // A run that ended a minute ago, so the real clock's windows hold it.
      spend("two", new Date(Date.now() - 60_000).toISOString(), 0.5);
      const cookie = await signIn("alice", "a-good-passphrase");
      const res = await fetch(`${servers.url}/fleet/graph?repo=alice/two`, {
        headers: { cookie },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      const body = await res.text();
      expect(body).toContain('id="fleet-graph"');
      expect(body).toContain('data-src="/fleet/graph/live?repo=alice%2Ftwo"');
      expect(body).toContain('data-repo="alice/two"');
      expect(body).toContain("Last 24 hours");
      expect(body).toContain("in the UTC hour or day it ended");
      expect(body).toContain('href="/fleet/graph.csv?repo=alice%2Ftwo"');
      // Built from DESIGN.md §5: the field row, the stacked bar chart, the
      // series dot and the table — no page-local fleet-* class (#3197).
      expect(body).toContain('<form method="get" action="/fleet/graph" class="field-row mb">');
      expect(body).toMatch(/<input\s+class="input mono" id="fleet-repos"[^>]*spellcheck="false"/);
      expect(body).toContain('<div class="plots">');
      expect(body).toMatch(/<svg\s+class="plot"[^>]*width="600"\s+height="230"/);
      expect(body).toContain('<ul class="plot-legend">');
      expect(body).toContain('<span class="dot" data-series="0" aria-hidden="true"></span>');
      expect(body).toContain('<table class="table" data-dense>');
      expect(body).not.toMatch(/class="[^"]*\bfleet-/);

      const live = await fetch(`${servers.url}/fleet/graph/live?repo=alice/two`, {
        headers: { cookie },
      });
      expect(live.status).toBe(200);
      const fragment = await live.text();
      expect(fragment.trimStart().startsWith("<section")).toBe(true);
      expect(fragment).toContain("$0.50");
    });

    test("another owner's selection shows nothing of theirs", async () => {
      const cookie = await signIn("bob", "another-good-passphrase");
      const body = await (
        await fetch(`${servers.url}/fleet/graph?repo=alice/one`, { headers: { cookie } })
      ).text();
      expect(body).toContain("None of these repositories is yours");
      expect(body).not.toContain('data-repo="alice/one"');
      expect(body).toContain("1 of the names asked for is not shown");
    });

    test("signed out is sent to sign in; the fragment and the API refuse", async () => {
      const page = await fetch(`${servers.url}/fleet/graph`, { redirect: "manual" });
      expect([302, 303]).toContain(page.status);
      expect(page.headers.get("location")).toContain("/signin");
      expect((await fetch(`${servers.url}/fleet/graph/live`)).status).toBe(404);
      expect((await fetch(`${servers.url}/api/v1/fleet/graph`)).status).toBe(401);
    });

    test("a malformed selection is refused, and its words are escaped", async () => {
      const cookie = await signIn("alice", "a-good-passphrase");
      const res = await fetch(
        `${servers.url}/fleet/graph?repo=${encodeURIComponent('"><script>x</script>')}`,
        { headers: { cookie } },
      );
      expect(res.status).toBe(422);
      const body = await res.text();
      expect(body).not.toContain("<script>x</script>");
      expect(body).toContain("&lt;script&gt;");
      expect(body).not.toContain("error-note");
      expect(body).toMatch(/id="fleet-repos"[^>]*aria-invalid="true"[\s\S]*?id="fleet-repos-err"/);
    });

    test("the API answers the same numbers, and refuses a bad name", async () => {
      const token = createToken(app.db, alice.id, "ro", "ro").token;
      const auth = { authorization: `Bearer ${token}` };
      const bad = await fetch(`${servers.url}/api/v1/fleet/graph?repo=nope`, {
        headers: auth,
      });
      expect(bad.status).toBe(422);
      expect(((await bad.json()) as { error: string }).error).toBe("invalid_selection");
      const res = await fetch(
        `${servers.url}/api/v1/fleet/graph?repo=alice/one&repo=bob/three`,
        { headers: auth },
      );
      expect(res.status).toBe(200);
      const g = (await res.json()) as {
        series: { label: string }[];
        hidden: number;
        windows: { name: string; buckets: unknown[] }[];
      };
      expect(g.series.map((s) => s.label)).toEqual(["alice/one"]);
      expect(g.hidden).toBe(1);
      expect(g.windows.map((w) => [w.name, w.buckets.length])).toEqual([
        ["24h", 24],
        ["14d", 14],
      ]);
    });
  });
});

describe("the redraw", () => {
  test("the client script has no timer loop and names its events in one list", () => {
    expect(fleetGraphClientJs).not.toContain("setInterval");
    expect(FLEET_GRAPH_EVENTS).toEqual(["run.started", "usage.delta", "run.finished"]);
    expect(fleetGraphClientJs).toContain(JSON.stringify(FLEET_GRAPH_EVENTS));
    expect(fleetGraphClientJs).toContain("forge:event");
    expect(fleetGraphClientJs).toContain("visibilitychange");
  });

  test("the source file carries no setInterval or refresh constant", async () => {
    const src = await Bun.file("src/web/fleet-graph.ts").text();
    expect(src).not.toMatch(/setInterval\s*\(/);
    expect(src).not.toContain("FLEET_GRAPH_REFRESH_MS");
  });
});

describe("the redraw, run against a stub page", () => {
  function page() {
    const listeners: Record<string, ((e: unknown) => void)[]> = {};
    const fetched: string[] = [];
    const timers: { fn: () => void; ms: number }[] = [];
    let now = 10_000;
    const section = { getAttribute: () => "/fleet/graph/live", replaceWith() {} };
    const document = {
      visibilityState: "visible",
      getElementById: () => section,
      addEventListener: (n: string, f: (e: unknown) => void) => (listeners[n] ??= []).push(f),
      importNode: (x: unknown) => x,
    };
    const fetch = (src: string) => {
      fetched.push(src);
      return Promise.resolve({ ok: false });
    };
    new Function("document", "fetch", "DOMParser", "setTimeout", "Date", fleetGraphClientJs)(
      document, fetch, class {}, (fn: () => void, ms: number) => timers.push({ fn, ms }),
      { now: () => now },
    );
    const emit = (kind: string) => listeners["forge:event"]?.forEach((f) => f({ detail: { kind } }));
    const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
    return { emit, fetched, timers, flush, advance: (ms: number) => { now += ms; } };
  }

  test("a matching kind draws once, a non-matching kind never", async () => {
    const p = page();
    p.emit("issue.opened");
    expect(p.timers).toHaveLength(0);
    for (const kind of FLEET_GRAPH_EVENTS) {
      const q = page();
      q.emit(kind);
      expect(q.timers).toHaveLength(1);
      q.timers[0]!.fn();
      expect(q.fetched).toEqual(["/fleet/graph/live"]);
    }
  });

  test("a burst inside the gap coalesces to one trailing redraw", async () => {
    const p = page();
    p.emit("usage.delta");
    p.timers[0]!.fn();
    await p.flush();
    p.advance(200);
    p.emit("usage.delta");
    p.emit("run.finished");
    expect(p.timers).toHaveLength(2);
    expect(p.timers[1]!.ms).toBe(800);
    p.timers[1]!.fn();
    expect(p.fetched).toHaveLength(2);
  });
});
