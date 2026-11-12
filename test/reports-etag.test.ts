/** GET …/reports carries a weak ETag and answers a repeat with 304 until a report arrives or is answered (#9203). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let seq = 0;
const tok: Record<string, string> = {};
const url = (path: string) => `${servers.url}/api/v1/repos/ada/${path}`;
const get = (token: string | null, path: string, headers: Record<string, string> = {}) =>
  fetch(url(path), { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
const tagOf = async (path = "game/reports") => {
  const r = await get(tok["owner"]!, path);
  await r.text();
  return r.headers.get("etag")!;
};
const file = async (title: string): Promise<string> => {
  const r = await fetch(url("game/reports"), {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${++seq}` },
    body: JSON.stringify({ title }),
  });
  expect(r.status).toBe(202);
  return ((await r.json()) as { id: string }).id;
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-reports-etag-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const make = async (username: string) => {
    const r = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: true });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  const owner = await make("ada");
  const other = await make("rita");
  const made = await createRepo(app, owner, { name: "game", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  tok["owner"] = createToken(app.db, owner.id, "rw", "rw").token;
  tok["ro"] = createToken(app.db, owner.id, "ro", "ro").token;
  tok["other"] = createToken(app.db, other.id, "rw", "rw").token;
}, 30_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("200 carries a weak tag, private no-cache and vary; a repeat is a bodiless 304 with the floor headers", async () => {
  await file("first");
  const res = await get(tok["owner"]!, "game/reports");
  expect(res.status).toBe(200);
  const tag = res.headers.get("etag")!;
  expect(tag).toMatch(/^W\//);
  expect(res.headers.get("cache-control")).toBe("private, no-cache");
  expect(res.headers.get("vary")).toContain("authorization, cookie");
  expect(res.headers.get("content-type")).toBe("application/json");
  expect(await res.text()).toContain("first");
  const again = await get(tok["owner"]!, "game/reports", { "if-none-match": tag });
  expect(again.status).toBe(304);
  expect(again.headers.get("etag")).toBe(tag);
  expect(again.headers.get("cache-control")).toBe("private, no-cache");
  expect(again.headers.get("vary")).toContain("authorization, cookie");
  expect(again.headers.get("x-content-type-options")).toBe("nosniff");
  expect(again.headers.get("content-security-policy")).not.toBeNull();
  expect(await again.text()).toBe("");
});

test("a report filed, dismissed or accepted moves the tag", async () => {
  const before = await tagOf();
  const id = await file("second");
  const filed = await get(tok["owner"]!, "game/reports", { "if-none-match": before });
  expect(filed.status).toBe(200);
  await filed.text();
  const afterFiled = filed.headers.get("etag")!;
  expect(afterFiled).not.toBe(before);

  const d = await fetch(url(`game/reports/${id}/dismiss`), { method: "POST", headers: { authorization: `Bearer ${tok["owner"]}` } });
  expect(d.status).toBe(200);
  const dismissed = await get(tok["owner"]!, "game/reports", { "if-none-match": afterFiled });
  expect(dismissed.status).toBe(200);
  await dismissed.text();
  expect(dismissed.headers.get("etag")).not.toBe(afterFiled);

  const third = await file("third");
  const mid = await tagOf();
  const a = await fetch(url(`game/reports/${third}/accept`), {
    method: "POST",
    headers: { authorization: `Bearer ${tok["owner"]}`, "content-type": "application/json" },
    body: "{}",
  });
  expect(a.status).toBe(201);
  const accepted = await get(tok["owner"]!, "game/reports", { "if-none-match": mid });
  expect(accepted.status).toBe(200);
  await accepted.text();
});

test("a different window gets its own tag", async () => {
  await file("fourth");
  const whole = await tagOf();
  const one = await tagOf("game/reports?limit=1");
  expect(one).not.toBe(whole);
  const res = await get(tok["owner"]!, "game/reports?limit=1", { "if-none-match": whole });
  expect(res.status).toBe(200);
  await res.text();
  expect((await get(tok["owner"]!, "game/reports?limit=1", { "if-none-match": one })).status).toBe(304);
});

test("a token short of rw, a non-writer, a bad window and a missing repository answer as before, with no tag, even for *", async () => {
  const star = { "if-none-match": "*" };
  const ro = await get(tok["ro"]!, "game/reports", star);
  expect(ro.status).toBe(403);
  expect(ro.headers.get("etag")).toBeNull();
  const other = await get(tok["other"]!, "game/reports", star);
  expect(other.status).toBe(403);
  expect(other.headers.get("etag")).toBeNull();
  const bad = await get(tok["owner"]!, "game/reports?limit=0", star);
  expect(bad.status).toBe(422);
  expect(bad.headers.get("etag")).toBeNull();
  const missing = await get(tok["owner"]!, "nope/reports", star);
  expect(missing.status).toBe(404);
  expect(missing.headers.get("etag")).toBeNull();
});
