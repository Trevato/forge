/**
 * The worst event-loop lag of the last 10 s (#10288): the window by hand,
 * then a real 150 ms block seen as `lag;dur` on the next response and as
 * `loopLagMs` on `/healthz`, and gone once the injected clock steps 10 s.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { withLag } from "../src/core/route_timing.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createLoopWorst, startLoopWorst, stopLoopWorst } from "../src/perf/loop_worst.ts";

function blockFor(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // a synchronous job holding the thread, as the lab's stalls do
  }
}

/** `lag;dur=<n>` out of a Server-Timing header, or null. */
function lagOf(header: string | null): number | null {
  const m = /(?:^|,\s*)lag;dur=([\d.]+)/.exec(header ?? "");
  return m === null ? null : Number(m[1]);
}

describe("the window, by hand", () => {
  test("keeps the worst of the last ten one-second slots", () => {
    const w = createLoopWorst();
    expect(w.worst(0)).toBe(0);
    w.note(3, 100);
    w.note(150, 2_500);
    w.note(7, 2_900);
    w.note(12, 9_000);
    expect(w.worst(9_999)).toBe(150);
    // Second 2 leaves the window when second 12 begins: slots 3..12 remain.
    expect(w.worst(11_999)).toBe(150);
    expect(w.worst(12_000)).toBe(12);
    expect(w.worst(18_999)).toBe(12);
    expect(w.worst(19_000)).toBe(0);
  });

  test("a slot reused a lap later forgets what it held", () => {
    const w = createLoopWorst();
    w.note(300, 1_000);
    w.note(2, 11_000);
    expect(w.worst(11_000)).toBe(2);
  });

  test("refuses what is not a lateness", () => {
    const w = createLoopWorst();
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) w.note(bad, 0);
    w.note(5, Number.NaN);
    expect(w.worst(0)).toBe(0);
  });

  test("a tick (note then worst) costs under 0.1 ms on average over 100k", () => {
    const w = createLoopWorst();
    const ticks = 100_000;
    let sink = 0;
    const t0 = performance.now();
    // Each tick: one wake 50 ms apart on the window clock, then one header read.
    for (let k = 0; k < ticks; k++) {
      w.note(k % 97, k * 50);
      sink += w.worst(k * 50);
    }
    const meanMs = (performance.now() - t0) / ticks;
    expect(sink).toBeGreaterThan(0);
    expect(meanMs).toBeLessThan(0.1);
  });

  test("withLag appends one token and ignores a non-number", () => {
    expect(withLag("app;dur=3.0", 148.26)).toBe("app;dur=3.0, lag;dur=148.3");
    expect(withLag("app;dur=3.0", Number.NaN)).toBe("app;dur=3.0");
  });
});

describe("on every response", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let skew = 0;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-loop-worst-"));
    app = createApp({ dataDir, port: 0 });
    // Wake every 5 ms, so a 150 ms block reads as at least 145; the window
    // reads a clock the test can step.
    stopLoopWorst();
    startLoopWorst({ clock: () => performance.now() + skew, everyMs: 5 });
    servers = await serve(app);
  });

  afterAll(async () => {
    stopLoopWorst();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a 150 ms block shows as lag;dur ≥ 140 on the next response, then falls out", async () => {
    blockFor(150);
    // The overdue wake runs before this one: timers fire in due order.
    await new Promise((r) => setTimeout(r, 0));
    const res = await fetch(`${servers.url}/nope`);
    await res.text();
    const header = res.headers.get("server-timing");
    expect(header).toContain("app;dur=");
    expect(lagOf(header)).toBeGreaterThanOrEqual(140);

    const health = await fetch(`${servers.url}/healthz`, { headers: { accept: "application/json" } });
    const body = (await health.json()) as { ok: boolean; loopLagMs: number };
    expect(body.ok).toBe(true);
    expect(body.loopLagMs).toBeGreaterThanOrEqual(140);
    // A probe asking for nothing still hears the plain `ok` (#2917).
    expect(await (await fetch(`${servers.url}/healthz`)).text()).toBe("ok");

    // Ten seconds on the window's clock with no new wake: nothing is left in it.
    stopLoopWorst();
    startLoopWorst({ clock: () => performance.now() + skew, everyMs: 60_000 });
    skew += 10_000;
    const later = await fetch(`${servers.url}/nope`);
    await later.text();
    expect(lagOf(later.headers.get("server-timing"))).toBe(0);
  });
});
