/** GET and PUT /api/v1/user/notify: read, set, clear and each refusal over HTTP (#7884). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createAgent } from "../src/actions/crew.ts";
import { NOTIFY_ERRORS } from "../src/crew/notify.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let admin = "";
let rw = "";
let agent = "";
let cookie = "";
const events: string[] = [];

const cells = process.env["FORGE_CELLS"];
const URL_ = "https://ntfy.example.com/secret-topic-token";

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-api-notify-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!made.ok) throw new Error(String(made.error));
  const alice = made.value;
  admin = createToken(app.db, alice.id, "a", "admin").token;
  rw = createToken(app.db, alice.id, "w", "rw").token;
  cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  const bot = await createAgent(app, alice, { username: "bot" });
  if (!bot.ok) throw new Error(String(bot.error));
  agent = createToken(app.db, bot.value.user.id, "b", "admin").token;
  const append = app.bus.append.bind(app.bus);
  app.bus.append = ((e: { kind: string }) => (events.push(e.kind), append(e as never))) as typeof app.bus.append;
});
afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

const call = (method: string, token: string, body?: unknown, extra: Record<string, string> = {}) =>
  fetch(`${servers.url}/api/v1/user/notify`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

test("read, set, clear: the host only, and the bus hears each write", async () => {
  expect(await (await call("GET", admin)).json()).toEqual({ set: false, host: null });
  const put = await call("PUT", admin, { url: URL_ });
  expect(put.status).toBe(200);
  const text = await put.text();
  expect(JSON.parse(text)).toEqual({ set: true, host: "ntfy.example.com" });
  expect(text).not.toContain("secret-topic-token");
  const got = await (await call("GET", rw)).text();
  expect(JSON.parse(got)).toEqual({ set: true, host: "ntfy.example.com" });
  expect(got).not.toContain("secret-topic-token");
  const cleared = await call("PUT", admin, { url: "" });
  expect(await cleared.json()).toEqual({ set: false, host: null });
  expect(events.filter((k) => k === "account.notify_set").length).toBe(2);
});

test("refusals: agent, scope, bad URL, bad body, cross-site, anonymous", async () => {
  expect((await call("GET", agent)).status).toBe(403);
  const a = await call("PUT", agent, { url: URL_ });
  expect(a.status).toBe(403);
  expect(((await a.json()) as { error: string }).error).toBe("forbidden");
  expect((await call("PUT", rw, { url: URL_ })).status).toBe(403);
  const bad = await call("PUT", admin, { url: "http://example.com/x" });
  expect(bad.status).toBe(422);
  expect(((await bad.json()) as { message: string }).message).toBe(NOTIFY_ERRORS.not_https);
  expect((await call("PUT", admin, { url: 5 })).status).toBe(422);
  const cross = await fetch(`${servers.url}/api/v1/user/notify`, {
    method: "PUT",
    headers: { cookie, origin: "https://evil.example", "content-type": "application/json" },
    body: JSON.stringify({ url: URL_ }),
  });
  expect(cross.status).toBe(403);
  expect((await fetch(`${servers.url}/api/v1/user/notify`)).status).toBe(401);
  expect((await call("GET", admin)).status).toBe(200);
  expect(await (await call("GET", admin)).json()).toEqual({ set: false, host: null });
});

test("the OpenAPI document lists both", async () => {
  const doc = (await (await fetch(`${servers.url}/api/v1/openapi.json`)).json()) as { paths: Record<string, Record<string, unknown>> };
  expect(Object.keys(doc.paths["/api/v1/user/notify"] ?? {}).sort()).toEqual(["get", "put"]);
});
