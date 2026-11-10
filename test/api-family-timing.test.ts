/** The API's forge family reads name their Server-Timing phases (#3937). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { requestTiming } from "./helpers/request-timing.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";
const cells = process.env["FORGE_CELLS"];

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-api-family-timing-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(String(made.error));
  cookie = `forge_session=${createSession(app.db, made.value.id).token}`;
});

afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

async function phases(path: string, withCookie = true) {
  const res = await fetch(`${servers.url}${path}`, { headers: withCookie ? { cookie } : {} });
  const body = await res.text();
  const names = requestTiming(res).split(", ").map((p) => p.split(";")[0]!);
  return { status: res.status, names: names.slice(names.indexOf("app") + 1), body };
}

test("GET /api/v1/family names session, read, render", async () => {
  const got = await phases("/api/v1/family");
  expect(got.status).toBe(200);
  expect(got.names).toEqual(["session", "read", "render"]);
  expect(typeof JSON.parse(got.body)).toBe("object");
});

test("GET /api/v1/forges names session, read, render for an admin", async () => {
  const got = await phases("/api/v1/forges");
  expect(got.status).toBe(200);
  expect(got.names).toEqual(["session", "read", "render"]);
  expect(JSON.parse(got.body).next_cursor).toBeNull();
});

test("GET /api/v1/forges refuses a stranger and still names session", async () => {
  const got = await phases("/api/v1/forges", false);
  expect(got.status).toBeGreaterThanOrEqual(401);
  expect(got.status).toBeLessThanOrEqual(403);
  expect(got.names).toEqual(["session"]);
});

test("GET /api/v1/forge on an unspawned forge 404s naming session and read", async () => {
  const got = await phases("/api/v1/forge");
  expect(got.status).toBe(404);
  expect(got.names).toEqual(["session", "read"]);
});
