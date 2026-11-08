/** GET …/hooks and …/hooks/:id/deliveries carry an ETag and answer a repeat with 304 (#9169). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { createWebhook } from "../src/core/webhooks.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let adminTok = "";
let readTok = "";
let otherTok = "";
let hookA = "";
let hookB = "";
const cells = process.env["FORGE_CELLS"];
const HOOKS = "/api/v1/repos/alice/a/hooks";
const get = (path: string, tok: string, headers: Record<string, string> = {}) =>
  fetch(`${servers.url}${path}`, { headers: { authorization: `Bearer ${tok}`, ...headers } });
const ping = (id: string) =>
  fetch(`${servers.url}${HOOKS}/${id}/ping`, { method: "POST", headers: { authorization: `Bearer ${adminTok}` } });
const tagOf = async (path: string) => {
  const res = await get(path, adminTok);
  expect(res.status).toBe(200);
  await res.text();
  return res.headers.get("etag")!;
};

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-hooks-etag-"));
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
  const a = createWebhook(app.db, { repoId: ra.value.id, url: "https://a.example/h" });
  const b = createWebhook(app.db, { repoId: ra.value.id, url: "https://b.example/h" });
  if (!a.ok || !b.ok) throw new Error("hook");
  hookA = a.value.webhook.id;
  hookB = b.value.webhook.id;
  adminTok = createToken(app.db, alice.id, "t", "admin").token;
  readTok = createToken(app.db, alice.id, "r", "ro").token;
  otherTok = createToken(app.db, bob.id, "o", "admin").token;
});
afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

const hooksUrl = () => HOOKS;
const deliveriesUrl = () => `${HOOKS}/${hookA}/deliveries`;

function sharedTests(label: string, url: () => string, strictNotFound: boolean) {
  test(`${label}: a weak tag, private no-cache, vary`, async () => {
    const res = await get(url(), adminTok);
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toMatch(/^W\/"/);
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("vary")).toContain("authorization, cookie");
    await res.text();
  });

  test(`${label}: a repeat is a bodiless 304 with the floor`, async () => {
    const tag = await tagOf(url());
    const again = await get(url(), adminTok, { "if-none-match": tag });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(tag);
    expect(again.headers.get("cache-control")).toBe("private, no-cache");
    expect(again.headers.get("vary")).toContain("authorization, cookie");
    expect(again.headers.get("x-content-type-options")).toBe("nosniff");
    expect(again.headers.get("referrer-policy")).not.toBeNull();
    expect(await again.text()).toBe("");
  });

  test(`${label}: non-admins and strangers get no tag, even with *`, async () => {
    for (const tok of [readTok, otherTok]) {
      const res = await get(url(), tok, { "if-none-match": "*" });
      expect(res.headers.get("etag")).toBeNull();
      expect(res.status).not.toBe(304);
      expect(strictNotFound ? [404] : [403, 404]).toContain(res.status);
      await res.text();
    }
  });
}

sharedTests("hooks", hooksUrl, false);
sharedTests("deliveries", deliveriesUrl, true);

test("a missing hook is 404 without a tag, even with *", async () => {
  const res = await get(`${HOOKS}/nope/deliveries`, adminTok, { "if-none-match": "*" });
  expect(res.status).toBe(404);
  expect(res.headers.get("etag")).toBeNull();
  await res.text();
});

test("adding and removing a hook moves the hooks tag", async () => {
  let tag = await tagOf(HOOKS);
  const made = await fetch(`${servers.url}${HOOKS}`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminTok}`, "content-type": "application/json" },
    body: JSON.stringify({ url: "https://c.example/h" }),
  });
  expect(made.status).toBe(201);
  const id = ((await made.json()) as { id: string }).id;
  const res = await get(HOOKS, adminTok, { "if-none-match": tag });
  expect(res.status).toBe(200);
  expect(res.headers.get("etag")).not.toBe(tag);
  tag = res.headers.get("etag")!;
  await res.text();
  const del = await fetch(`${servers.url}${HOOKS}/${id}`, { method: "DELETE", headers: { authorization: `Bearer ${adminTok}` } });
  expect(del.status).toBe(200);
  const after = await get(HOOKS, adminTok, { "if-none-match": tag });
  expect(after.status).toBe(200);
  expect(after.headers.get("etag")).not.toBe(tag);
  await after.text();
});

test("a ping moves that hook's deliveries tag and not the other's", async () => {
  const a = await tagOf(`${HOOKS}/${hookA}/deliveries`);
  const b = await tagOf(`${HOOKS}/${hookB}/deliveries`);
  expect((await ping(hookA)).status).toBe(202);
  // Poll, bounded, so the test never depends on when the row lands.
  let moved = await get(`${HOOKS}/${hookA}/deliveries`, adminTok, { "if-none-match": a });
  for (let i = 0; i < 50 && moved.status === 304; i++) {
    await Bun.sleep(20);
    moved = await get(`${HOOKS}/${hookA}/deliveries`, adminTok, { "if-none-match": a });
  }
  expect(moved.status).toBe(200);
  expect(moved.headers.get("etag")).not.toBe(a);
  await moved.text();
  const still = await get(`${HOOKS}/${hookB}/deliveries`, adminTok, { "if-none-match": b });
  expect(still.status).toBe(304);
});
