/** /plugins/opencode/forge.ts serves the repository's plugin file (#10198). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { reservedName } from "../src/core/reserved.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const ROOT = join(import.meta.dir, "..");
let dir: string;
let app: App;
let servers: Servers;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "plugin-routes-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("200: the file's bytes, as text/plain, with an ETag and the security floor", async () => {
  const res = await fetch(`${servers.url}/plugins/opencode/forge.ts`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(res.headers.get("etag")).toBeTruthy();
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("referrer-policy")).toBeTruthy();
  expect(res.headers.get("content-security-policy")).toBeTruthy();
  expect(await res.text()).toBe(readFileSync(join(ROOT, "plugins/opencode/forge.ts"), "utf8"));
});

test("304: a matching If-None-Match has no body", async () => {
  const first = await fetch(`${servers.url}/plugins/opencode/forge.ts`);
  const etag = first.headers.get("etag")!;
  const again = await fetch(`${servers.url}/plugins/opencode/forge.ts`, { headers: { "if-none-match": etag } });
  expect(again.status).toBe(304);
  expect(await again.text()).toBe("");
  const other = await fetch(`${servers.url}/plugins/opencode/forge.ts`, { headers: { "if-none-match": 'W/"nope"' } });
  expect(other.status).toBe(200);
});

test("`plugins` is a reserved name", () => {
  expect(reservedName(app.db, "plugins")).toBeDefined();
});

test("the Dockerfile copies plugins/opencode", () => {
  const copies = readFileSync(join(ROOT, "Dockerfile"), "utf8")
    .split("\n")
    .filter((l) => l.startsWith("COPY ") && !l.includes("--from"))
    .flatMap((l) => l.trim().split(/\s+/).slice(1, -1).map((p) => p.replace(/\/$/, "")));
  expect(copies).toContain("plugins/opencode");
});
