/**
 * The app proxy adds little to a warm app's answer (#8186): the median over a
 * direct fetch of the app's port stays under 5 ms and the p95 under 20 ms,
 * with the pill's rewrite and without it. Compared to a direct fetch made in
 * the same test, so a loaded machine slows both sides alike.
 */

import { afterAll, beforeAll, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { AppsRuntime, type EnvStatus } from "../src/apps/runtime.ts";
import { proxyApp, resolveAppHost, type AppSocket } from "../src/apps/proxy.ts";
import { takePhases } from "../src/core/route_timing.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const DOMAIN = "apps.test";
const RUNS = 25;
const MEDIAN_MS = 5;
const P95_MS = 20;
// Rounds are tried for at most this long (under the test's own timeout), and at
// least ROUNDS of them: a loaded lane can stay slow for many seconds, a real
// regression stays slow in every round.
const ROUNDS = 20;
const WINDOW_MS = 10_000;
// One in-flight round and slowest() fit after the window, so the budget message wins.
const TIMEOUT_MS = WINDOW_MS + 15_000;
// About the size of the scaffold app's home page.
const PAGE = `<!doctype html><html><head><title>notes</title></head><body>${"<p>hello hello hello</p>".repeat(60)}</body></html>`;

/** A plain GET never upgrades, so the proxy only holds this; it is never called. */
const NO_SOCKETS = { upgrade: () => false } as unknown as Bun.Server<AppSocket>;

let dataDir: string;
let app: App;
let servers: Servers;
let runtime: AppsRuntime;
let backend: ReturnType<typeof Bun.serve>;
let toolbar: boolean | undefined = undefined;
let status: ReturnType<typeof spyOn>;

beforeAll(async () => {
  backend = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } }),
  });
  dataDir = await mkdtemp(join(tmpdir(), "forge-proxy-timing-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
  servers = await serve(app);
  runtime = new AppsRuntime(app, {
    domain: DOMAIN,
    scheme: "http",
    publicPort: servers.port,
    forgeUrl: servers.url,
    concurrency: 1,
  });
  await runtime.start();
  status = spyOn(AppsRuntime.prototype, "envStatus").mockImplementation(
    () =>
      ({
        env: "production",
        state: "running",
        port: backend.port,
        commitOid: "a".repeat(40),
        toolbar,
      }) as EnvStatus,
  );
  const a = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!a.ok) throw new Error(a.error);
  const made = await newApp(app, a.value, {
    name: "notes",
    description: "A place for words",
    visibility: "public",
  });
  if (!made.ok) throw new Error(String(made.error));
}, 120_000);

afterAll(async () => {
  status.mockRestore();
  await runtime.stop();
  servers.stop();
  backend.stop(true);
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const HEADERS = { host: `notes.${DOMAIN}`, accept: "text/html" };

async function time(url: string, headers: Record<string, string>): Promise<number> {
  const started = performance.now();
  const res = await fetch(url, { headers, redirect: "manual" });
  await res.arrayBuffer();
  return performance.now() - started;
}

const at = (sorted: number[], q: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;

/** The five slowest phases of the forge's side of a request, for a failure to name. */
async function slowest(): Promise<string> {
  const request = new Request(`${servers.url}/`, { headers: HEADERS });
  const target = resolveAppHost(app, DOMAIN, request);
  if (target === undefined || target === "unknown") return "(no target)";
  const totals = new Map<string, number>();
  for (let i = 0; i < 20; i++) {
    const r = new Request(`${servers.url}/`, { headers: HEADERS });
    const res = await proxyApp(runtime, r, target, NO_SOCKETS);
    await res?.arrayBuffer();
    for (const p of takePhases(r)) totals.set(p.name, (totals.get(p.name) ?? 0) + p.ms / 20);
  }
  return [...totals]
    .sort((x, y) => y[1] - x[1])
    .slice(0, 5)
    .map(([n, ms]) => `${n}=${ms.toFixed(2)}ms`)
    .join(", ");
}

for (const [label, pill] of [["with the toolbar rewrite", undefined], ["without it", false]] as const) {
  test(`the proxy adds under ${MEDIAN_MS} ms (median) and ${P95_MS} ms (p95) ${label}`, async () => {
    toolbar = pill;
    const direct = `http://127.0.0.1:${backend.port}/`;
    const proxied = `${servers.url}/`;
    // The first test in the file pays for cold code (the rewrite, the JIT) that
    // the second never sees, so warm both paths well past the first few calls.
    for (let i = 0; i < 30; i++) {
      await time(direct, { accept: "text/html" });
      await time(proxied, HEADERS);
    }
    // Load only ever adds time, so the proxy's own cost is the floor of what
    // is measured: judge the lowest median and the lowest p95 over several short
    // rounds (ROUNDS). A change that costs more than the budget raises that floor in
    // every round and fails; a noisy round cannot.
    let median = Infinity;
    let p95 = Infinity;
    let directMedian = Infinity;
    const began = performance.now();
    let rounds = 0;
    while (rounds < ROUNDS || performance.now() - began < WINDOW_MS) {
      rounds++;
      const overhead: number[] = [];
      const directs: number[] = [];
      for (let i = 0; i < RUNS; i++) {
        // Back to back, so a slow moment on the machine lands on both.
        const d = await time(direct, { accept: "text/html" });
        const p = await time(proxied, HEADERS);
        overhead.push(p - d);
        directs.push(d);
      }
      overhead.sort((x, y) => x - y);
      directs.sort((x, y) => x - y);
      directMedian = Math.min(directMedian, at(directs, 0.5));
      median = Math.min(median, at(overhead, 0.5));
      p95 = Math.min(p95, at(overhead, 0.95));
      if (median < MEDIAN_MS && p95 < P95_MS) return;
    }
    throw new Error(
      `proxy overhead floor: median ${median.toFixed(2)} ms (budget ${MEDIAN_MS}), p95 ${p95.toFixed(2)} ms (budget ${P95_MS}) over ${rounds} rounds (direct fetch median floor ${directMedian.toFixed(2)} ms, load average ${loadavg().map((l) => l.toFixed(1)).join(" ")}; a high direct floor means a loaded machine, a low one means the proxy); five slowest phases: ${await slowest()}`,
    );
  }, TIMEOUT_MS);
}
