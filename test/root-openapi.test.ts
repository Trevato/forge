/** #8330: /openapi.json at the root redirects to the contract, as /api/v1/openapi.json does. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir: string;
let servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-rootopenapi-"));
  servers = await serve(createApp({ dataDir, port: 0 }));
});
afterAll(async () => {
  servers.stop();
  await rm(dataDir, { recursive: true, force: true });
});

test("GET and HEAD /openapi.json answer 308 to the contract", async () => {
  for (const method of ["GET", "HEAD"]) {
    const res = await fetch(`${servers.url}/openapi.json`, { method, redirect: "manual" });
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/contract/openapi.json");
  }
});
