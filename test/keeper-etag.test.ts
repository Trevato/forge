/** GET /api/v1/keeper carries a weak ETag and answers a repeat with 304 until a release moves (#9204). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { lift, setHold } from "../src/keeper/hold.ts";
import { finish, markLive, recordCut } from "../src/keeper/record.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir = "";
let app: App, servers: Servers;
const tok: Record<string, string> = {};
const get = (token: string | null, headers: Record<string, string> = {}) =>
  fetch(`${servers.url}/api/v1/keeper`, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
const tagOf = async () => {
  const r = await get(tok["admin"]!);
  expect(r.status).toBe(200);
  await r.text();
  return r.headers.get("etag")!;
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-keeper-etag-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, first: boolean) => {
    const made = await createUser(app.db, {
      origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first,
    });
    if (!made.ok) throw new Error(String(made.error));
    return made.value;
  };
  const ada = await mk("ada", true);
  const bob = await mk("bob", false);
  tok["admin"] = createToken(app.db, ada.id, "a", "admin").token;
  tok["bob"] = createToken(app.db, bob.id, "b", "admin").token;
}, 30_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("200 carries a weak tag, private no-cache and vary; a repeat is a bodiless 304 with the floor headers", async () => {
  const res = await get(tok["admin"]!);
  expect(res.status).toBe(200);
  const tag = res.headers.get("etag")!;
  expect(tag).toMatch(/^W\//);
  expect(res.headers.get("cache-control")).toBe("private, no-cache");
  expect(res.headers.get("vary")).toContain("authorization, cookie");
  expect(res.headers.get("content-type")).toBe("application/json");
  expect(tag).toBe(`W/"${Bun.hash(await res.text()).toString(36)}"`);
  const again = await get(tok["admin"]!, { "if-none-match": tag });
  expect(again.status).toBe(304);
  expect(again.headers.get("etag")).toBe(tag);
  expect(again.headers.get("cache-control")).toBe("private, no-cache");
  expect(again.headers.get("vary")).toContain("authorization, cookie");
  expect(again.headers.get("x-content-type-options")).toBe("nosniff");
  expect(again.headers.get("content-security-policy")).not.toBeNull();
  expect(await again.text()).toBe("");
});

test("recording, promoting, holding and rolling back a release each move the tag", async () => {
  const t0 = await tagOf();
  const cut = recordCut(app.db, { version: "v1", sha: "abcdef1234", knownGood: { version: "v0", image: "img0" }, at: 1_000 });
  const t1 = await tagOf();
  expect(t1).not.toBe(t0);
  expect((await get(tok["admin"]!, { "if-none-match": t0 })).status).toBe(200);
  expect(markLive(app.db, cut.id, 2_000)).toBe(true);
  const t2 = await tagOf();
  expect(t2).not.toBe(t1);
  const hold = setHold(app.db, { kind: "owner", version: "v1", reason: "hold", at: 3_000 });
  const t3 = await tagOf();
  expect(t3).not.toBe(t2);
  expect((await get(tok["admin"]!, { "if-none-match": t3 })).status).toBe(304);
  finish(app.db, cut.id, "rolled_back", "bad", 4_000);
  const t4 = await tagOf();
  expect(t4).not.toBe(t3);
  lift(app.db, hold.id, "ada", 5_000);
  expect(await tagOf()).not.toBe(t4);
});

test("a stranger and an anonymous caller answer 403 as before, with no tag, even for *", async () => {
  for (const token of [tok["bob"]!, null]) {
    const res = await get(token, { "if-none-match": "*" });
    expect(res.status).toBe(403);
    expect(res.headers.get("etag")).toBeNull();
    expect(((await res.json()) as any).error).toBe("forbidden");
  }
});
