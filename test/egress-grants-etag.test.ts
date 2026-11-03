/** GET …/egress-grants carries an ETag and answers a repeat with 304 (#9179). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let adminTok = "";
let readTok = "";
let otherTok = "";
const cells = process.env["FORGE_CELLS"];
const URL_ = "/api/v1/repos/alice/a/egress-grants";
const DEST = "100.89.95.68:8101";
const get = (path: string, tok: string, headers: Record<string, string> = {}) =>
  fetch(`${servers.url}${path}`, { headers: { authorization: `Bearer ${tok}`, ...headers } });
const change = (method: "POST" | "DELETE", destination: string) =>
  fetch(`${servers.url}${URL_}`, {
    method,
    headers: { authorization: `Bearer ${adminTok}`, "content-type": "application/json" },
    body: JSON.stringify({ destination }),
  });
const tagOf = async () => {
  const res = await get(URL_, adminTok);
  expect(res.status).toBe(200);
  await res.text();
  return res.headers.get("etag")!;
};
const moved = async (tag: string) => {
  const res = await get(URL_, adminTok, { "if-none-match": tag });
  expect(res.status).toBe(200);
  const next = res.headers.get("etag")!;
  expect(next).not.toBe(tag);
  await res.text();
  return next;
};

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-egress-etag-"));
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
  const repo = await createRepo(app, alice, { name: "a", visibility: "public" });
  if (!repo.ok) throw new Error("repo");
  const done = await commitToBranch(app, alice, repo.value, {
    message: "egress",
    files: [
      {
        path: "forge.json",
        content: JSON.stringify({ app: { run: "bun run src/server.ts" }, egress: [DEST] }),
      },
    ],
  });
  if (!done.ok) throw new Error(JSON.stringify(done.error));
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

test("a weak tag over the body, private no-cache, vary", async () => {
  const res = await get(URL_, adminTok);
  expect(res.status).toBe(200);
  expect(res.headers.get("etag")).toMatch(/^W\/"/);
  expect(res.headers.get("cache-control")).toBe("private, no-cache");
  expect(res.headers.get("vary")).toContain("authorization, cookie");
  expect(res.headers.get("content-type")).toContain("application/json");
  const body = (await res.json()) as { items: { destination: string }[] };
  expect(body.items.map((r) => r.destination)).toEqual([DEST]);
});

test("a repeat is a bodiless 304 with the floor", async () => {
  const tag = await tagOf();
  const again = await get(URL_, adminTok, { "if-none-match": tag });
  expect(again.status).toBe(304);
  expect(again.headers.get("etag")).toBe(tag);
  expect(again.headers.get("cache-control")).toBe("private, no-cache");
  expect(again.headers.get("vary")).toContain("authorization, cookie");
  expect(again.headers.get("x-content-type-options")).toBe("nosniff");
  expect(again.headers.get("referrer-policy")).not.toBeNull();
  expect(again.headers.get("content-security-policy")).not.toBeNull();
  expect(await again.text()).toBe("");
});

test("granting and revoking move the tag", async () => {
  let tag = await tagOf();
  expect((await change("POST", DEST)).status).toBe(201);
  tag = await moved(tag);
  expect((await get(URL_, adminTok, { "if-none-match": tag })).status).toBe(304);
  expect((await change("DELETE", DEST)).status).toBe(200);
  await moved(tag);
});

test("a refused grant changes nothing the view lists, so the tag holds", async () => {
  const tag = await tagOf();
  const refused = await change("POST", "100.89.95.69:9999");
  expect(refused.status).toBe(422);
  await refused.text();
  expect((await get(URL_, adminTok, { "if-none-match": tag })).status).toBe(304);
});

test("a token short of admin and a non-admin get no tag, even with *", async () => {
  for (const tok of [readTok, otherTok]) {
    const res = await get(URL_, tok, { "if-none-match": "*" });
    expect(res.headers.get("etag")).toBeNull();
    expect([403, 404]).toContain(res.status);
    await res.text();
  }
});

test("a missing repository is 404 without a tag, even with *", async () => {
  const res = await get("/api/v1/repos/alice/nope/egress-grants", adminTok, { "if-none-match": "*" });
  expect(res.status).toBe(404);
  expect(res.headers.get("etag")).toBeNull();
  await res.text();
});
