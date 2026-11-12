/** #11104: the API root and the error hints name /contract/openapi.json, which answers 200 itself, not the path that redirects. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir = "";
let servers: Servers;
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-root-contract-"));
  servers = await serve(createApp({ dataDir, port: 0 }));
});
afterAll(async () => {
  await servers.stop?.();
  await rm(dataDir, { recursive: true, force: true });
});

test("the root's openapi link answers 200 with no redirect", async () => {
  const root = (await (await fetch(`${servers.url}/api/v1`)).json()) as { openapi: string };
  expect(new URL(root.openapi).pathname).toBe("/contract/openapi.json");
  const res = await fetch(`${servers.url}/contract/openapi.json`, { redirect: "manual" });
  expect(res.status).toBe(200);
});

test("the 404 hint names the contract path, and the old path still redirects", async () => {
  const res = await fetch(`${servers.url}/api/v1/nope-nothing`, { headers: { accept: "application/json" } });
  const body = JSON.stringify(await res.json());
  expect(body).toContain("/contract/openapi.json");
  expect(body).not.toContain("/api/v1/openapi.json");
  const old = await fetch(`${servers.url}/api/v1/openapi.json`, { redirect: "manual" });
  expect(old.status).toBe(308);
});
