/** POST …/hooks/:id/ping, MCP `hooks` action `ping` and the settings page's Send ping (#8006). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { createWebhook, deliverDue, recentDeliveries, verifySignature } from "../src/core/webhooks.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { LOOPBACK } from "./helpers/loopback-hook.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let adminTok = "";
let otherTok = "";
let cookie = "";
let hookA = "";
let hookB = "";
let secretA = "";
let received: { body: string; sig: string; kind: string }[] = [];
let receiver: ReturnType<typeof Bun.serve>;
const cells = process.env["FORGE_CELLS"];

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  receiver = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      received.push({
        body: await req.text(),
        sig: req.headers.get("x-forge-signature-256") ?? "",
        kind: req.headers.get("x-forge-event") ?? "",
      });
      return new Response("ok");
    },
  });
  dataDir = await mkdtemp(join(tmpdir(), "forge-hook-ping-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, first: boolean) => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: first,
    });
    if (!made.ok) throw new Error(String(made.error));
    return made.value;
  };
  const alice = await mk("alice", true);
  const bob = await mk("bob", false);
  const ra = await createRepo(app, alice, { name: "a", visibility: "public" });
  if (!ra.ok) throw new Error("repo");
  // Subscribes to issues only: a ping must reach it anyway. The other hook hears nothing.
  const a = createWebhook(app.db, { repoId: ra.value.id, url: "https://a.example/h", kinds: "issue.opened" });
  const b = createWebhook(app.db, { repoId: ra.value.id, url: "https://b.example/h" });
  if (!a.ok || !b.ok) throw new Error("hook");
  hookA = a.value.webhook.id;
  hookB = b.value.webhook.id;
  secretA = a.value.secret;
  adminTok = createToken(app.db, alice.id, "t", "admin").token;
  cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  otherTok = createToken(app.db, bob.id, "o", "admin").token;
});
afterAll(async () => {
  receiver.stop(true);
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

const ping = (hook: string, tok: string) =>
  fetch(`${servers.url}/api/v1/repos/alice/a/hooks/${hook}/ping`, { method: "POST", headers: { authorization: `Bearer ${tok}` } });
const mcp = async (args: unknown) => {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${adminTok}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "hooks", arguments: args } }),
  });
  const body = (await res.json()) as any;
  const text: string = body.result.content[0].text;
  return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
};
const resetWindow = () => app.db.run("UPDATE webhook_ping SET created_at = '2020-01-01T00:00:00.000Z'");

test("a ping answers 202, shows among the deliveries and reaches only that hook", async () => {
  const res = await ping(hookA, adminTok);
  expect(res.status).toBe(202);
  const { id } = (await res.json()) as { id: string };
  const api = await fetch(`${servers.url}/api/v1/repos/alice/a/hooks/${hookA}/deliveries`, { headers: { authorization: `Bearer ${adminTok}` } });
  const items = ((await api.json()) as any).items;
  expect(items[0]).toMatchObject({ id, kind: "ping", state: "pending" });
  const viaMcp = await mcp({ repo: "alice/a", action: "deliveries", id: hookA });
  expect(viaMcp.value.items[0]).toMatchObject({ id, kind: "ping" });
  expect(recentDeliveries(app.db, hookB)).toHaveLength(0);
});

test("the ping is signed and goes through deliverDue, body { kind, repo, hook, at }", async () => {
  received = [];
  app.db.run("UPDATE webhook SET url = ?2 WHERE id = ?1", [hookA, `http://127.0.0.1:${receiver.port}/h`]);
  await deliverDue(app.db, app.log, new Date(), LOOPBACK);
  expect(received).toHaveLength(1);
  const hit = received[0]!;
  expect(hit.kind).toBe("ping");
  const body = JSON.parse(hit.body);
  expect(Object.keys(body).sort()).toEqual(["at", "hook", "kind", "repo"]);
  expect(body).toMatchObject({ kind: "ping", repo: "alice/a", hook: hookA });
  expect(await verifySignature(secretA, hit.body, hit.sig)).toBe(true);
});

test("a private address is refused as a failed delivery with its reason, never fetched inline", async () => {
  resetWindow();
  const res = await ping(hookB, adminTok);
  expect(res.status).toBe(202);
  expect(recentDeliveries(app.db, hookB)[0]).toMatchObject({ kind: "ping", state: "pending", attempts: 0 });
  app.db.run("UPDATE webhook SET url = 'https://127.0.0.1/h' WHERE id = ?1", [hookB]);
  await deliverDue(app.db, app.log);
  expect(recentDeliveries(app.db, hookB)[0]).toMatchObject({ kind: "ping", state: "failed" });
  expect(recentDeliveries(app.db, hookB)[0]!.lastError).toBeTruthy();
});

test("a non-admin, a missing hook and no credentials are refused", async () => {
  expect((await ping(hookA, otherTok)).status).toBe(404);
  expect((await ping("nope", adminTok)).status).toBe(404);
  const anon = await fetch(`${servers.url}/api/v1/repos/alice/a/hooks/${hookA}/ping`, { method: "POST" });
  expect(anon.status).toBe(401);
});

test("past three a minute it is 429 with retry-after, over the API and MCP", async () => {
  resetWindow();
  for (let i = 0; i < 3; i++) expect((await ping(hookA, adminTok)).status).toBe(202);
  const over = await ping(hookA, adminTok);
  expect(over.status).toBe(429);
  expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
  const m = await mcp({ repo: "alice/a", action: "ping", id: hookA });
  expect(m.error).toContain("too many pings");
  resetWindow();
  const ok = await mcp({ repo: "alice/a", action: "ping", id: hookA });
  expect(typeof ok.value.id).toBe("string");
});

test("a ping is not an event: the repository's event log, feed and stream never hear of it", async () => {
  resetWindow();
  const before = app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM event").get()!.n;
  expect((await ping(hookA, adminTok)).status).toBe(202);
  expect(app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM event").get()!.n).toBe(before);
  expect(app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM event WHERE kind = 'ping'").get()!.n).toBe(0);
  const events = await fetch(`${servers.url}/api/v1/repos/alice/a/events?kind=ping`);
  expect(((await events.json()) as any).items).toHaveLength(0);
  const all = await fetch(`${servers.url}/api/v1/repos/alice/a/events`);
  expect(JSON.stringify(await all.json())).not.toContain("ping");
});

test("the limit counts deliveries, so it holds with nothing in the event log", async () => {
  resetWindow();
  for (let i = 0; i < 3; i++) expect((await ping(hookB, adminTok)).status).toBe(202);
  expect((await ping(hookB, adminTok)).status).toBe(429);
  expect(app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM event WHERE kind = 'ping'").get()!.n).toBe(0);
});

const send = (hook: string, headers: Record<string, string>) =>
  fetch(`${servers.url}/alice/a/settings/hooks/${hook}/ping`, { method: "POST", redirect: "manual", headers: { cookie, ...headers } });

test("the hooks page has a Send ping form; posting it queues a delivery, a cross-site post does not", async () => {
  resetWindow();
  const page = await (await fetch(`${servers.url}/alice/a/settings/hooks`, { headers: { cookie } })).text();
  expect(page).toContain(`action="/alice/a/settings/hooks/${hookA}/ping"`);
  expect(page).toContain("Send ping");
  const n = () => recentDeliveries(app.db, hookA, 50).length;
  const before = n();
  expect((await send(hookA, { origin: "https://evil.example" })).status).toBe(403);
  expect(n()).toBe(before);
  const ok = await send(hookA, { origin: servers.url });
  expect(ok.status).toBe(303);
  expect(n()).toBe(before + 1);
  expect(recentDeliveries(app.db, hookA, 1)[0]).toMatchObject({ kind: "ping", state: "pending" });
});

test("the page post past the limit is a message, not a delivery; a stranger gets nothing", async () => {
  resetWindow();
  for (let i = 0; i < 3; i++) await send(hookA, { origin: servers.url });
  const before = recentDeliveries(app.db, hookA, 50).length;
  const over = await send(hookA, { origin: servers.url });
  expect(over.status).toBe(303);
  expect(recentDeliveries(app.db, hookA, 50)).toHaveLength(before);
  const shown = await (await fetch(`${servers.url}/alice/a/settings/hooks`, { headers: { cookie: over.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") + "; " + cookie } })).text();
  expect(shown).toContain("Too many pings");
  const anon = await fetch(`${servers.url}/alice/a/settings/hooks/${hookA}/ping`, { method: "POST", redirect: "manual", headers: { origin: servers.url } });
  expect(anon.status).toBe(404);
  expect(recentDeliveries(app.db, hookA, 50)).toHaveLength(before);
});
