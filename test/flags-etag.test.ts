/** GET /api/v1/flags carries a weak ETag and answers a repeat with 304 until a flag changes (#9214). */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { makeFlags } from "../src/core/flags.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { weakEtag } from "../src/http/etag.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { useFlagRegistry } from "../src/web/pages/flags.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASS = "a-long-flags-passphrase";
const reg = makeFlags({ alpha: { why: "shows the new board", default: false, issue: 5417 } });

let dataDir = "";
let app: App;
let servers: Servers;
const tokenOf = (name: string) => createToken(app.db, getUserByName(app.db, name)!.id, "t", "ro").token;
const get = (token: string | null, headers: Record<string, string> = {}) =>
  fetch(`${servers.url}/api/v1/flags`, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-flags-etag-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  for (const [username, isAdmin] of [["alice", true], ["bob", false]] as const) {
    const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@x.test`, password: PASS, isAdmin });
    if (!made.ok) throw new Error(username);
  }
  useFlagRegistry(reg);
}, 30_000);

afterAll(async () => {
  useFlagRegistry(undefined);
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("200 carries a weak tag over the body, private no-cache and vary; the body is unchanged", async () => {
  const res = await get(tokenOf("alice"));
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toBe(JSON.stringify({ flags: [{ name: "alpha", why: "shows the new board", default: false, issue: 5417 }] }));
  expect(res.headers.get("content-type")).toBe("application/json");
  expect(res.headers.get("etag")).toBe(weakEtag(text));
  expect(res.headers.get("cache-control")).toBe("private, no-cache");
  expect(res.headers.get("vary")).toContain("authorization, cookie");
});

test("a repeat holding the tag is a bodiless 304 with the same headers and the floor", async () => {
  const token = tokenOf("alice");
  const first = await get(token);
  const tag = first.headers.get("etag")!;
  await first.text();
  const again = await get(token, { "if-none-match": tag });
  expect(again.status).toBe(304);
  expect(again.headers.get("etag")).toBe(tag);
  expect(again.headers.get("cache-control")).toBe("private, no-cache");
  expect(again.headers.get("vary")).toContain("authorization, cookie");
  expect(again.headers.get("x-content-type-options")).toBe("nosniff");
  expect(again.headers.get("content-security-policy")).not.toBeNull();
  expect(again.headers.get("referrer-policy")).not.toBeNull();
  expect(await again.text()).toBe("");
});

test("turning a flag on, then off, moves the tag each time", async () => {
  const token = tokenOf("alice");
  const alice = getUserByName(app.db, "alice")!;
  const tagNow = async () => {
    const r = await get(token);
    await r.text();
    return r.headers.get("etag")!;
  };
  const before = await tagNow();
  expect(reg.set(app.db, "alpha", { forge: true }, alice.id)).toBe(true);
  const on = await get(token, { "if-none-match": before });
  expect(on.status).toBe(200);
  expect(((await on.json()) as any).flags[0].value).toEqual({ forge: true });
  const onTag = on.headers.get("etag")!;
  expect(onTag).not.toBe(before);
  expect(reg.set(app.db, "alpha", { forge: false }, alice.id)).toBe(true);
  const off = await get(token, { "if-none-match": onTag });
  expect(off.status).toBe(200);
  await off.text();
  expect(off.headers.get("etag")).not.toBe(onTag);
  reg.set(app.db, "alpha", undefined, alice.id);
});

test("no session is 401 and a refused viewer 403, with no ETag even holding *", async () => {
  const anon = await get(null, { "if-none-match": "*" });
  expect(anon.status).toBe(401);
  expect(anon.headers.get("etag")).toBeNull();
  expect(((await anon.json()) as any).error).toBeDefined();
  const bob = await get(tokenOf("bob"), { "if-none-match": "*" });
  expect(bob.status).toBe(403);
  expect(bob.headers.get("etag")).toBeNull();
  expect(JSON.stringify(await bob.json())).toContain("Flags are set by a forge admin.");
  // A tag an admin was given buys a refused viewer nothing.
  const adm = await get(tokenOf("alice"));
  await adm.text();
  const replay = await get(tokenOf("bob"), { "if-none-match": adm.headers.get("etag")! });
  expect(replay.status).toBe(403);
  expect(replay.headers.get("etag")).toBeNull();
});
