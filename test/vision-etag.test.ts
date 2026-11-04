/** GET …/vision carries a weak ETag and answers a repeat with 304 until the direction moves (#9202). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { openPull } from "../src/actions/pulls.ts";
import { savePlacement } from "../src/core/placements.ts";
import { createRepo, getRepo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
const tok: Record<string, string> = {};
const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const get = (token: string | null, path: string, headers: Record<string, string> = {}) =>
  fetch(`${servers.url}/api/v1/repos/ada/${path}`, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
const tagOf = async (token: string | null, path = "with/vision") => {
  const r = await get(token, path);
  await r.text();
  return r.headers.get("etag")!;
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-vision-etag-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const make = (username: string) =>
    createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase" });
  const owner = ok(await make("ada"));
  const reader = ok(await make("rita"));
  const text = await readFile(join(import.meta.dir, "..", "docs", "VISION.md"), "utf8");
  const pub = ok(await createRepo(app.db, app.reposRoot, { ownerId: owner.id, name: "with", visibility: "public" }));
  ok(await commitToBranch(app, owner, pub, { message: "vision", files: [{ path: "docs/VISION.md", content: text }] }));
  ok(await createRepo(app.db, app.reposRoot, { ownerId: owner.id, name: "secret", visibility: "private" }));
  app.db.query("UPDATE repo SET autonomy_direction = 'ship the feed, quietly' WHERE id = ?1").run(pub.id);
  tok["owner"] = createToken(app.db, owner.id, "rw", "rw").token;
  tok["reader"] = createToken(app.db, reader.id, "rw", "rw").token;
}, 30_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("200 carries a weak tag, private no-cache and vary; a repeat is a bodiless 304 with the floor headers", async () => {
  const res = await get(tok["owner"]!, "with/vision");
  expect(res.status).toBe(200);
  const tag = res.headers.get("etag")!;
  expect(tag).toMatch(/^W\//);
  expect(res.headers.get("cache-control")).toBe("private, no-cache");
  expect(res.headers.get("vary")).toContain("authorization, cookie");
  expect(res.headers.get("content-type")).toBe("application/json");
  await res.text();
  const again = await get(tok["owner"]!, "with/vision", { "if-none-match": tag });
  expect(again.status).toBe(304);
  expect(again.headers.get("etag")).toBe(tag);
  expect(again.headers.get("cache-control")).toBe("private, no-cache");
  expect(again.headers.get("vary")).toContain("authorization, cookie");
  expect(again.headers.get("x-content-type-options")).toBe("nosniff");
  expect(again.headers.get("content-security-policy")).not.toBeNull();
  expect(await again.text()).toBe("");
});

test("the direction changing moves the tag", async () => {
  const before = await tagOf(tok["owner"]!);
  app.db.query("UPDATE repo SET autonomy_direction = 'ship the feed, loudly' WHERE name = 'with'").run();
  const res = await get(tok["owner"]!, "with/vision", { "if-none-match": before });
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("loudly");
  expect(res.headers.get("etag")).not.toBe(before);
});

test("a different number gets its own tag, and a preview moves it", async () => {
  const owner = getUserByName(app.db, "ada")!;
  const repo = getRepo(app.db, "ada", "with")!;
  const md = (await readFile(join(import.meta.dir, "..", "docs", "VISION.md"), "utf8")).replace("Done means reachable", "Done means shown");
  ok(await commitToBranch(app, owner, repo, { branch: "vision-r", message: "v", files: [{ path: "docs/VISION.md", content: md }] }));
  const pull = ok(await openPull(app, owner, repo, { title: "Note", body: "", baseBranch: "main", headBranch: "vision-r" }));
  const path = `with/vision?number=${pull.number}`;
  const none = await tagOf(tok["owner"]!, path);
  const plain = await tagOf(tok["owner"]!);
  savePlacement(app.db, {
    thoughtId: "thetag", kind: "vision", reply: "", asked: false, decidedBy: "t", placedAt: new Date().toISOString(),
    placed: [{ action: "proposed", repo: "ada/with", number: pull.number, pull: pull.number }],
  });
  const shown = await tagOf(tok["owner"]!, path);
  expect(shown).not.toBe(none);
  expect(shown).not.toBe(plain);
  expect((await get(tok["owner"]!, path, { "if-none-match": shown })).status).toBe(304);
  expect((await get(tok["owner"]!, path, { "if-none-match": plain })).status).toBe(200);
});

test("viewers shown different bodies never share a tag, and a tag buys another viewer nothing", async () => {
  const owner = await tagOf(tok["owner"]!);
  const reader = await tagOf(tok["reader"]!);
  const anon = await tagOf(null);
  expect(owner).not.toBe(reader);
  expect(reader).toBe(anon);
  const replay = await get(tok["reader"]!, "with/vision", { "if-none-match": owner });
  expect(replay.status).toBe(200);
  expect(await replay.text()).not.toContain("loudly");
});

test("invalid_number and a missing repository answer as before, with no tag, even for If-None-Match: *", async () => {
  const bad = await get(tok["owner"]!, "with/vision?number=0", { "if-none-match": "*" });
  expect(bad.status).toBe(422);
  expect(bad.headers.get("etag")).toBeNull();
  expect(((await bad.json()) as any).error).toBe("invalid_number");
  for (const [token, path] of [[tok["reader"]!, "secret/vision"], [null, "secret/vision"], [tok["owner"]!, "nope/vision"]] as const) {
    const res = await get(token, path, { "if-none-match": "*" });
    expect(res.status).toBe(404);
    expect(res.headers.get("etag")).toBeNull();
  }
});
