/** GET /api/v1/conversations carries a weak ETag and answers a repeat with 304 until a conversation changes (#9247). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { appendTurn } from "../src/core/conversations.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir = "";
let app: App, servers: Servers;
const tok: Record<string, string> = {};
const ids: Record<string, string> = {};
const call = (method: string, path: string, token: string | undefined, extra: Record<string, string> = {}, body?: unknown) =>
  fetch(`${servers.url}/api/v1/${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}), ...extra },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
const tagOf = async (path = "conversations", token = tok["ada"]!) => {
  const r = await call("GET", path, token);
  expect(r.status).toBe(200);
  await r.text();
  return r.headers.get("etag")!;
};
const stale = async (tag: string, path = "conversations") => {
  const r = await call("GET", path, tok["ada"]!, { "if-none-match": tag });
  await r.text();
  return r.status;
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-conv-etag-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  for (const [username, first] of [["ada", true], ["bob", false]] as const) {
    const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first });
    if (!made.ok) throw new Error(String(made.error));
    ids[username] = made.value.id;
    tok[username] = createToken(app.db, made.value.id, username, "admin").token;
  }
});

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("200 carries a weak etag and the cache headers; a repeat is a bodiless 304 with the floor", async () => {
  expect((await call("POST", "conversations", tok["ada"]!, {}, { title: "one" })).status).toBe(201);
  const r = await call("GET", "conversations", tok["ada"]!);
  const tag = r.headers.get("etag")!;
  expect(tag).toMatch(/^W\//);
  expect(r.headers.get("cache-control")).toBe("private, no-cache");
  expect(r.headers.get("vary")).toContain("authorization, cookie");
  expect(((await r.json()) as { conversations: unknown[] }).conversations).toHaveLength(1);
  const again = await call("GET", "conversations", tok["ada"]!, { "if-none-match": tag });
  expect(again.status).toBe(304);
  expect(await again.text()).toBe("");
  expect(again.headers.get("etag")).toBe(tag);
  expect(again.headers.get("cache-control")).toBe("private, no-cache");
  expect(again.headers.get("vary")).toContain("authorization, cookie");
  expect(again.headers.get("x-content-type-options")).toBe("nosniff");
  expect(again.headers.get("content-security-policy")).toBeTruthy();
});

test("create, rename, archive, unarchive and a turn each move the tag", async () => {
  let tag = await tagOf();
  const step = async (what: () => Promise<unknown> | unknown) => {
    await what();
    expect(await stale(tag)).toBe(200);
    tag = await tagOf();
  };
  let id = "";
  await step(async () => {
    id = ((await (await call("POST", "conversations", tok["ada"]!, {}, {})).json()) as { conversation: { id: string } }).conversation.id;
  });
  await step(() => call("PATCH", `conversations/${id}`, tok["ada"]!, {}, { title: "renamed" }));
  await step(async () => { await Bun.sleep(5); appendTurn(app.db, ids["ada"]!, id, { role: "person", text: "hi" }); });
  await step(() => call("PATCH", `conversations/${id}`, tok["ada"]!, {}, { archived: true }));
  await step(() => call("PATCH", `conversations/${id}`, tok["ada"]!, {}, { archived: false }));
  expect(await stale(tag)).toBe(304);
});

test("archived=1 has its own etag; two viewers never share one", async () => {
  const live = await tagOf();
  const archived = await tagOf("conversations?archived=1");
  expect(archived).not.toBe(live);
  expect(await stale(live, "conversations?archived=1")).toBe(200);
  const bob = await call("GET", "conversations", tok["bob"]!, { "if-none-match": live });
  expect(bob.status).toBe(200);
  expect(bob.headers.get("etag")).not.toBe(live);
});

test("no session is 401 with no etag, even with If-None-Match: *", async () => {
  const plain = await call("GET", "conversations", undefined);
  const star = await call("GET", "conversations", undefined, { "if-none-match": "*" });
  expect(plain.status).toBe(401);
  expect(star.status).toBe(401);
  expect(star.headers.get("etag")).toBeNull();
  expect(await star.text()).toBe(await plain.text());
});
