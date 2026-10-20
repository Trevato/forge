/** Every route the OpenAPI document describes is one the router serves. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { ROUTES } from "../src/contract/openapi.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir: string;
let app: App;
let servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-openapi-served-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const sample = (name: string) => (name === "number" ? "1" : "sample");

test("every described method and path resolves to a handler, not no_route", async () => {
  expect(ROUTES.length).toBeGreaterThan(5);
  const missing: string[] = [];
  for (const r of ROUTES) {
    const path = r.path.replace(/\{(\w+)\}/g, (_, n: string) => sample(n));
    const res = await fetch(`${servers.url}${path}`, {
      method: r.method.toUpperCase(),
      headers: { "content-type": "application/json", accept: "application/json" },
      ...(r.method === "get" ? {} : { body: "{}" }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 404 && body.error === "no_route") missing.push(`${r.method.toUpperCase()} ${r.path}`);
  }
  expect(missing, `described but not served: ${missing.join(", ")}`).toEqual([]);
});
