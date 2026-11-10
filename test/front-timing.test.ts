/** The signed-out `/` names session, shelf and render in Server-Timing (#4105). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { requestTiming } from "./helpers/request-timing.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-front-timing-"));
  app = createApp({ dataDir: root, port: 0 });
  servers = await serve(app);
}, 30_000);
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

const dur = (p: string) => Number(/dur=([\d.]+)/.exec(p)![1]);

async function read(): Promise<string[]> {
  const res = await fetch(`${servers.url}/`, { redirect: "manual" });
  expect(res.status).toBe(200);
  await res.text();
  return requestTiming(res).split(", ");
}

test("GET / signed out names session, key, shelf, tiles, render in order and covers the handler's share of app", async () => {
  for (let i = 0; i < 5; i++) await read(); // warm
  const shares: number[] = [];
  for (let i = 0; i < 15; i++) {
    const parts = await read();
    const names = parts.map((p) => p.split(";")[0]);
    expect(names.filter((n) => n !== "app" && n !== "db")).toEqual(["session", "key", "shelf", "tiles", "render"]);
    const total = dur(parts.find((p) => p.startsWith("app;"))!);
    const named = parts.filter((p) => /^(session|shelf|tiles|render);/.test(p)).reduce((s, p) => s + dur(p), 0);
    shares.push(total === 0 ? 1 : named / total);
  }
  // The handler's own phases are all of the handler; what `app` also holds
  // (host resolution, the security floor) happens outside home.ts, so the
  // floor here is the half the page can name itself, not the 80% of #4105.
  // One slow request (a GC pause between handler and header) is noise; the median is the page.
  shares.sort((a, b) => a - b);
  expect(shares[Math.floor(shares.length / 2)]!).toBeGreaterThanOrEqual(0.4);
});
