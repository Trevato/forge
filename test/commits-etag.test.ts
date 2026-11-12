/** GET …/commits carries a weak ETag and answers a repeat with 304 until the ref it reads moves (#9162). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let alice: User;
let repo: Repo;
const cells = process.env["FORGE_CELLS"];
const URL_ = "/api/v1/repos/alice/r/commits";
const get = (path = URL_, headers: Record<string, string> = {}) =>
  fetch(`${servers.url}${path}`, { headers });
const commit = async (message: string, branch?: string) => {
  const done = await commitToBranch(app, alice, repo, {
    message,
    files: [{ path: `${message}.txt`, content: message }],
    ...(branch ? { branch } : {}),
  });
  if (!done.ok) throw new Error(JSON.stringify(done.error));
};

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-commits-etag-"));
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
  alice = made.value;
  const r = await createRepo(app, alice, { name: "r", visibility: "public" });
  if (!r.ok) throw new Error(String(r.error));
  repo = r.value;
  await commit("one");
  await commit("side-one", "side");
});

afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

test("the 200 carries a weak tag, private no-cache and vary, and the body stays a bare array", async () => {
  const res = await get();
  expect(res.status).toBe(200);
  expect(res.headers.get("etag")).toMatch(/^W\/"/);
  expect(res.headers.get("cache-control")).toBe("private, no-cache");
  expect(res.headers.get("vary")).toContain("authorization, cookie");
  expect(Array.isArray(await res.json())).toBe(true);
});

test("a matching If-None-Match is a bodiless 304 with the same headers and the security floor", async () => {
  const tag = (await get()).headers.get("etag")!;
  const again = await get(URL_, { "if-none-match": tag });
  expect(again.status).toBe(304);
  expect(again.headers.get("etag")).toBe(tag);
  expect(again.headers.get("cache-control")).toBe("private, no-cache");
  expect(again.headers.get("vary")).toContain("authorization, cookie");
  expect(again.headers.get("x-content-type-options")).toBe("nosniff");
  expect(again.headers.get("content-security-policy")).toBeTruthy();
  expect(await again.text()).toBe("");
});

test("a push to the ref read misses; a push to another branch does not", async () => {
  const tag = (await get()).headers.get("etag")!;
  await commit("side-two", "side");
  expect((await get(URL_, { "if-none-match": tag })).status).toBe(304);
  await commit("two");
  const moved = await get(URL_, { "if-none-match": tag });
  expect(moved.status).toBe(200);
  expect(moved.headers.get("etag")).not.toBe(tag);
  await moved.text();
});

test("a different ref or limit gets a different etag", async () => {
  const base = (await get()).headers.get("etag");
  const side = (await get(`${URL_}?ref=side`)).headers.get("etag");
  const lim = (await get(`${URL_}?limit=1`)).headers.get("etag");
  expect(new Set([base, side, lim]).size).toBe(3);
  const stale = await get(`${URL_}?limit=1`, { "if-none-match": base! });
  expect(stale.status).toBe(200);
});

test("bad_ref 422 and 404 carry no etag", async () => {
  const bad = await get(`${URL_}?ref=${encodeURIComponent("--upload-pack=x")}`);
  expect(bad.status).toBe(422);
  expect(bad.headers.get("etag")).toBeNull();
  const missing = await get("/api/v1/repos/alice/nope/commits");
  expect(missing.status).toBe(404);
  expect(missing.headers.get("etag")).toBeNull();
});
