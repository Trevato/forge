/** A session cookie the forge does not accept reads as signed out everywhere (#7169). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession, destroySession, sessionUser } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { sha256 } from "../src/kernel/hash.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
const cells = process.env["FORGE_CELLS"];

async function person(username: string): Promise<string> {
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username,
    email: `${username}@forge.local`,
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(String(made.error));
  return made.value.id;
}

/** A token that is no longer accepted, for each way a session can stop. */
function refused(userId: string): Record<string, string> {
  const real = createSession(app.db, userId).token;
  const last = real.slice(-1);
  const tampered = real.slice(0, -1) + (last === "a" ? "b" : "a");

  const expired = createSession(app.db, userId).token;
  app.db
    .query("UPDATE session SET expires_at = ?1 WHERE token_hash = ?2")
    .run(new Date(Date.now() - 1000).toISOString(), sha256(expired));

  const signedOut = createSession(app.db, userId).token;
  destroySession(app.db, signedOut);

  return { random: "x".repeat(43), tampered, expired, signedOut };
}

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-session-refusals-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
});
afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

async function get(path: string, token: string | null) {
  const res = await fetch(`${servers.url}${path}`, {
    headers: token === null ? {} : { cookie: `forge_session=${token}` },
    redirect: "manual",
  });
  return { status: res.status, body: await res.text() };
}

test("sessionUser refuses forged, tampered, expired and signed-out tokens", async () => {
  const alice = await person("alice");
  for (const [name, token] of Object.entries(refused(alice))) {
    const got = sessionUser(app.db, token);
    expect(got.ok, name).toBe(false);
    if (!got.ok) expect(got.error, name).toBe("invalid_session");
  }
});

test("a live session still works", async () => {
  const alice = await person("dana");
  const { token } = createSession(app.db, alice);
  const got = sessionUser(app.db, token);
  expect(got.ok).toBe(true);
  const api = await get("/api/v1/user", token);
  expect(api.status).toBe(200);
  expect(JSON.parse(api.body).username).toBe("dana");
  expect((await get("/", token)).body).not.toBe((await get("/", null)).body);
});

test("over HTTP each refused cookie is signed out: the anonymous page and a 401", async () => {
  const id = await person("bob");
  const anonymous = await get("/", null);
  expect(anonymous.status).toBe(200);
  for (const [name, token] of Object.entries(refused(id))) {
    const page = await get("/", token);
    expect(page.status, name).toBe(200);
    expect(page.body, name).toBe(anonymous.body);
    expect((await get("/api/v1/user", token)).status, name).toBe(401);
  }
});

test("a suspended account's cookie is refused the same way", async () => {
  const id = await person("carol");
  const { token } = createSession(app.db, id);
  expect(sessionUser(app.db, token).ok).toBe(true);
  app.db
    .query("UPDATE user SET suspended_at = ?1 WHERE id = ?2")
    .run(new Date().toISOString(), id);
  const got = sessionUser(app.db, token);
  expect(got.ok).toBe(false);
  if (!got.ok) expect(got.error).toBe("invalid_session");
  const anonymous = await get("/", null);
  expect((await get("/", token)).body).toBe(anonymous.body);
  expect((await get("/api/v1/user", token)).status).toBe(401);
});
