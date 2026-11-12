/** A link-preview card's Server-Timing names session and resolve, then render (SVG) or raster (PNG). */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { requestTiming } from "./helpers/request-timing.ts";

setDefaultTimeout(30_000);

let dataDir: string;
let app: App;
let servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-ogt-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "alice-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  const made = await createRepo(app, u.value, { name: "shown", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
}, 60_000);

afterAll(async () => {
  await servers.stop();
  await rm(dataDir, { recursive: true, force: true });
}, 30_000);

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(servers.url + path, { headers });
  await res.arrayBuffer();
  const names = requestTiming(res)
    .split(", ")
    .map((p) => /^([a-z-]+);/.exec(p)?.[1])
    .filter((n): n is string => n !== undefined && n !== "app");
  return { res, names };
}

test("an SVG repo card names session, resolve and render", async () => {
  const { res, names } = await get("/og/repo/alice~shown.svg");
  expect(res.status).toBe(200);
  expect(names).toEqual(["session", "resolve", "render"]);
});

test("a PNG card names raster, or resolve when raster is unavailable", async () => {
  const { res, names } = await get("/og/repo/alice~shown.png");
  expect([200, 503]).toContain(res.status);
  if (res.status === 200) expect(names).toEqual(["session", "resolve", "raster"]);
  else expect(names).toEqual(["session", "resolve"]);
});

test("a 304 names session and resolve only", async () => {
  const first = await get("/og/repo/alice~shown.svg");
  const { res, names } = await get("/og/repo/alice~shown.svg", {
    "if-none-match": first.res.headers.get("etag")!,
  });
  expect(res.status).toBe(304);
  expect(names).toEqual(["session", "resolve"]);
});
