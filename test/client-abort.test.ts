/** A client that goes away settles its request as 499 and frees the handler (#2250). */

import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { accessDir, flushAccess } from "../src/http/access_log.ts";
import * as health from "../src/http/health.ts";
import { serve } from "../src/http/server.ts";
import { readUsage } from "../src/core/usage_count.ts";

let dataDir: string;
let app: App;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-abort-"));
  app = createApp({ dataDir, port: 0 });
});

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("an aborted slow request is logged and counted as 499, and nothing stays in flight", async () => {
  const servers = await serve(app);
  // A handler whose Response never comes: what an aborted request left behind.
  const stuck = spyOn(health, "readyResponse").mockImplementation(
    (() => new Promise(() => {})) as never,
  );
  try {
    const controller = new AbortController();
    const pending = fetch(`${servers.url}/readyz`, { signal: controller.signal }).catch(
      () => "aborted",
    );
    for (let i = 0; i < 100 && servers.inFlight === 0; i++) await Bun.sleep(10);
    expect(servers.inFlight).toBe(1);
    controller.abort();
    expect(await pending).toBe("aborted");
    for (let i = 0; i < 100 && servers.inFlight > 0; i++) await Bun.sleep(10);

    expect(servers.inFlight).toBe(0);
    flushAccess();
    const kept = readdirSync(accessDir(dataDir))
      .flatMap((f) => readFileSync(join(accessDir(dataDir), f), "utf8").split("\n"))
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as { path: string; status: number });
    expect(kept.find((l) => l.path === "/readyz")?.status).toBe(499);
  } finally {
    stuck.mockRestore();
    servers.stop();
  }
  // Stopping the server settles the usage counts.
  const rows = readUsage(app.db, "").filter((r) => r.pattern === "/readyz");
  expect(rows.map((r) => [r.status, r.n])).toEqual([["4xx", 1]]);
});

test("a body that arrives after the client left is cancelled", async () => {
  const servers = await serve(app);
  let cancelled = false;
  let release!: (r: Response) => void;
  const stuck = spyOn(health, "readyResponse").mockImplementation(
    (() => new Promise<Response>((resolve) => (release = resolve))) as never,
  );
  try {
    const controller = new AbortController();
    const pending = fetch(`${servers.url}/readyz`, { signal: controller.signal }).catch(
      () => "aborted",
    );
    for (let i = 0; i < 100 && servers.inFlight === 0; i++) await Bun.sleep(10);
    expect(servers.inFlight).toBe(1);
    controller.abort();
    expect(await pending).toBe("aborted");
    for (let i = 0; i < 100 && servers.inFlight > 0; i++) await Bun.sleep(10);
    if (servers.inFlight > 0) throw new Error(`never came: still waiting while servers.inFlight > 0`);
    release(
      new Response(
        new ReadableStream({
          pull(c) {
            c.enqueue(new TextEncoder().encode("late"));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
    );
    for (let i = 0; i < 100 && !cancelled; i++) await Bun.sleep(10);
    expect(cancelled).toBe(true);
    expect(servers.inFlight).toBe(0);
  } finally {
    stuck.mockRestore();
    servers.stop();
  }
});

test("a request that is not aborted is untouched, floor and all", async () => {
  const servers = await serve(app);
  const res = await fetch(`${servers.url}/readyz`);
  expect(res.status).toBe(200);
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  await res.text();
  expect(servers.inFlight).toBe(0);
  servers.stop();
});
