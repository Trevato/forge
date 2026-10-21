/** `GET /metrics` serves the duration histogram, and docs/METRICS.md lists every family it serves (#3975). */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRouteTiming } from "../src/core/route_timing.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dir: string;
let app: App;
let servers: Servers;
let ro: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "metrics-route-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  ro = createToken(app.db, made.value.id, "t", "ro").token;
}, 60_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const read = async () =>
  (await fetch(`${servers.url}/metrics`, { headers: { authorization: `Bearer ${ro}` } })).text();

test("a recorded request moves its bucket, count and sum", async () => {
  const pattern = "/zz/metrics-test/:id";
  const bucket = (text: string, le: string) =>
    Number(
      new RegExp(`forge_http_request_duration_seconds_bucket\\{pattern="${pattern.replace(/[/:]/g, (c) => `\\${c}`)}",le="${le.replace(".", "\\.").replace("+", "\\+")}"\\} (\\d+)`).exec(text)?.[1] ?? 0,
    );
  const before = await read();
  expect(bucket(before, "0.005")).toBe(0);
  const timing = createRouteTiming(app.db);
  timing.record(pattern, 3);
  timing.flush();
  const after = await read();
  expect(bucket(after, "0.002")).toBe(0);
  expect(bucket(after, "0.005")).toBe(1);
  expect(bucket(after, "+Inf")).toBe(1);
  expect(after).toContain(`forge_http_request_duration_seconds_count{pattern="${pattern}"} 1`);
  expect(after).toContain(`forge_http_request_duration_seconds_sum{pattern="${pattern}"} 0.003`);
  expect(after).not.toContain("# EOF");
});

test("a request without credentials is answered 404, as docs/METRICS.md says", async () => {
  const res = await fetch(`${servers.url}/metrics`);
  expect(res.status).toBe(404);
  const doc = await readFile(join(import.meta.dir, "..", "docs", "METRICS.md"), "utf8");
  expect(doc).toContain("404 without credentials");
});

test("every family the route serves is listed in docs/METRICS.md", async () => {
  const text = await read();
  const doc = await readFile(join(import.meta.dir, "..", "docs", "METRICS.md"), "utf8");
  const families = [...text.matchAll(/^# TYPE (\S+) /gm)].map((m) => m[1]!);
  expect(families).toContain("forge_egress_connections");
  expect(families).toContain("forge_http_request_duration_seconds");
  for (const f of families) expect(doc).toContain(`\`${f}\``);
});
