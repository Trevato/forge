/**
 * A child forge in a cell said its apps were running while every address of them answered 404 (Starck,
 * 2026-11-01): an app host of a child was only looked up when the parent's own app domain claimed the name,
 * and the lookup opened the child in-process, where a cell's child has no apps. The host reaches the cell now.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { cellChildren } from "../src/spawn/cell.ts";
import { resolveHostedChildApp } from "../src/spawn/host.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let parent: App;
let servers: Servers;
let cell: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cell-app-hosts-"));
  parent = createApp({ dataDir, url: "https://forge.test", port: 0 });
  // As in production: the parent's own apps hang from another domain than its children do.
  await new AppsRuntime(parent, { domain: "--apps.test", scheme: "https", forgeUrl: "https://forge.test", concurrency: 1 }).start();
  mkdirSync(join(dataDir, "spawn"), { recursive: true });
  writeFileSync(join(dataDir, "spawn", "kid.json"), JSON.stringify({ name: "kid", bodyId: "cell-k", done: true, placement: "cell", size: "small" }));
  cell = Bun.serve({ port: 0, fetch: (r) => new Response(`cell saw ${r.headers.get("host")}`) });
  const port = cell.port;
  (cellChildren(parent) as { get: unknown }).get = (id: string) => (id === "cell-k" ? { port } : undefined);
  servers = await serve(parent);
});

afterAll(() => {
  servers.stop();
  void cell.stop(true);
  parent.close();
});

const ask = (host: string) => fetch(`${servers.url}/`, { headers: { host }, redirect: "manual" });

test("a cell child's app host names the cell, and opens nothing here", async () => {
  const hit = await resolveHostedChildApp(parent, new Request("http://x/", { headers: { host: "deal--kid--forge.test" } }));
  expect(hit).toEqual({ cell: "kid" });
});

test("through the server, the app's request reaches the cell with its own Host", async () => {
  const res = await ask("deal--kid--forge.test");
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("cell saw deal--kid--forge.test");
});

test("the child's own host still reaches the cell, and a child that does not exist is not found", async () => {
  expect(await (await ask("kid--forge.test")).text()).toBe("cell saw kid--forge.test");
  expect((await ask("deal--nobody--forge.test")).status).toBe(404);
});
