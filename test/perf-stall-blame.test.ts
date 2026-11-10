/**
 * A loop stall over 200 ms is named by what ran (#11069): a real busy-wait
 * inside a marked job is blamed on that job, one in an unmarked callback is
 * `unknown`, the ring never grows past its size, /system lists the worst
 * five and `/healthz` (JSON) says what held the loop as `loopWorstWhat`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { startLoopLag } from "../src/kernel/loop_lag.ts";
import { createJobWatch } from "../src/perf/jobs.ts";
import { stallBlame } from "../src/perf/live.ts";
import { createLoopWatch, HOUR_MS, LIMIT_MS, type Stall } from "../src/perf/loop.ts";
import { createStallBlame, STALL_KEPT, UNKNOWN, whatOf } from "../src/perf/stall_blame.ts";
import { stallSection, worstStallsTable } from "../src/web/pages/system.ts";

function blockFor(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // the thread held, as a stall holds it
  }
}

/** Run `block` on the loop with a 10 ms lag sampler wired as main.ts wires it; resolves with the ring. */
async function stallUnder(block: (jobs: ReturnType<typeof createJobWatch>) => void) {
  const jobs = createJobWatch();
  const watch = createLoopWatch(LIMIT_MS, jobs.across);
  const blame = createStallBlame();
  const lag = startLoopLag(10, () => performance.now(), (late) => {
    const stall = watch.stalled(late, performance.now());
    if (stall !== null) blame.note(stall);
  });
  // Let the sampler arm, then hold the loop from a timer callback.
  await new Promise((r) => setTimeout(r, 15));
  await new Promise<void>((r) =>
    setTimeout(() => {
      block(jobs);
      r();
    }, 0),
  );
  // The overdue wake runs next.
  await new Promise((r) => setTimeout(r, 30));
  lag.stop();
  return blame;
}

describe("what a stall is blamed on", () => {
  test("the stall limit is 200 ms", () => {
    expect(LIMIT_MS).toBe(200);
  });

  test("a busy-wait inside a marked job is blamed on that job", async () => {
    const blame = await stallUnder((jobs) => jobs.during("snapshot", () => blockFor(260)));
    const [worst] = blame.worst(performance.now(), HOUR_MS, 5);
    expect(worst?.what).toBe("job:snapshot");
    expect(worst!.ms).toBeGreaterThan(200);
  });

  test("a busy-wait in an unmarked callback is unknown", async () => {
    const blame = await stallUnder(() => blockFor(260));
    const [worst] = blame.worst(performance.now(), HOUR_MS, 5);
    expect(worst?.what).toBe(UNKNOWN);
    expect(worst!.ms).toBeGreaterThan(200);
  });

  test("a route that ran across is named before any job", () => {
    const s: Stall = { at: 1, lateMs: 300, routes: ["/explore"], jobs: [] };
    expect(whatOf(s)).toBe("/explore");
    expect(whatOf({ ...s, routes: [], jobs: ["sampler"] })).toBe("job:sampler");
    expect(whatOf({ ...s, routes: [] })).toBe(UNKNOWN);
  });
});

describe("the ring", () => {
  test("never holds more than its size, and keeps the newest", () => {
    const blame = createStallBlame(8);
    for (let i = 0; i < 1_000; i++) blame.note({ at: i, lateMs: 201 + i, routes: [`/r${i}`], jobs: [] });
    expect(blame.size()).toBe(8);
    const all = blame.worst(10_000, 1e9, 100);
    expect(all.length).toBe(8);
    expect(all.map((s) => s.what)).toEqual(["/r999", "/r998", "/r997", "/r996", "/r995", "/r994", "/r993", "/r992"]);
    expect(createStallBlame().size()).toBe(0);
    expect(STALL_KEPT).toBe(256);
  });

  test("worst is the hour's, most ms first, at most n", () => {
    const blame = createStallBlame();
    const now = 10 * HOUR_MS;
    blame.note({ at: now - HOUR_MS - 1, lateMs: 9_000, routes: ["/old"], jobs: [] });
    for (const [ms, r] of [[300, "/a"], [800, "/b"], [250, "/c"], [500, "/d"], [700, "/e"], [210, "/f"]] as const)
      blame.note({ at: now - 1_000, lateMs: ms, routes: [r], jobs: [] });
    expect(blame.worst(now, HOUR_MS, 5).map((s) => [s.what, s.ms])).toEqual([
      ["/b", 800], ["/e", 700], ["/d", 500], ["/a", 300], ["/c", 250],
    ]);
  });

  test("an hour of solid stalling keeps the ring its size", () => {
    // 18,000 stalls: one every 200 ms for an hour; the ring holds its last STALL_KEPT.
    const blame = createStallBlame();
    for (let i = 0; i < 18_000; i++) blame.note({ at: i * 200, lateMs: 201, routes: ["/explore"], jobs: [] });
    expect(blame.size()).toBe(STALL_KEPT);
    expect(blame.worst(18_000 * 200, HOUR_MS, STALL_KEPT + 10).length).toBe(STALL_KEPT);
  });
});

describe("on /system", () => {
  test("lists what, ms and when, escaped", () => {
    const now = 5_000_000;
    const wall = Date.parse("2026-11-10T12:00:00Z");
    const out = String(worstStallsTable([{ what: "job:<x>", ms: 436.4, at: now - 120_000 }], now, wall));
    expect(out).toContain("Worst single stalls");
    expect(out).toContain("job:&lt;x&gt;");
    expect(out).not.toContain("job:<x>");
    expect(out).toContain(">436<");
    expect(out).toContain('datetime="2026-11-10T11:58:00.000Z"');
  });

  test("draws nothing when there is none, and sits inside the stalls section when there is", () => {
    expect(String(worstStallsTable([], 0, 0))).toBe("");
    const section = String(stallSection([], worstStallsTable([{ what: "/x", ms: 300, at: 0 }], 0, 0)));
    expect(section).toContain("Main-thread stalls, last hour");
    expect(section.indexOf("Worst single stalls")).toBeLessThan(section.indexOf("</section>"));
  });
});

describe("on /healthz", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-stall-blame-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
  });

  afterAll(async () => {
    stallBlame.clear();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("loopWorstWhat is null with no stall, then names the last 10 s's worst", async () => {
    stallBlame.clear();
    const ask = async () =>
      (await (await fetch(`${servers.url}/healthz`, { headers: { accept: "application/json" } })).json()) as {
        ok: boolean;
        loopLagMs: number;
        loopWorstWhat: string | null;
      };
    const before = await ask();
    expect(before.ok).toBe(true);
    expect(typeof before.loopLagMs).toBe("number");
    expect(before.loopWorstWhat).toBeNull();

    const now = performance.now();
    stallBlame.note({ at: now - 60_000, lateMs: 900, routes: ["/too-old"], jobs: [] });
    stallBlame.note({ at: now, lateMs: 300, routes: [], jobs: ["crew-tick"] });
    stallBlame.note({ at: now, lateMs: 220, routes: ["/explore"], jobs: [] });
    expect((await ask()).loopWorstWhat).toBe("job:crew-tick");
    // A probe asking for nothing still hears the plain `ok` (#2917).
    expect(await (await fetch(`${servers.url}/healthz`)).text()).toBe("ok");
  });
});
