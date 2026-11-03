/** GET …/prompts carries a weak ETag and answers a repeat with 304 until a prompt source moves (#9201). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { addPromptSource, listPromptSources, removePromptSource } from "../src/core/prompts.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir = "";
let app: App, servers: Servers;
let repoId = "";
const tok: Record<string, string> = {};
const get = (token: string | null, path = "ada/box/prompts", headers: Record<string, string> = {}) =>
  fetch(`${servers.url}/api/v1/repos/${path}`, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
const tagOf = async () => {
  const r = await get(tok["admin"]!);
  expect(r.status).toBe(200);
  await r.text();
  return r.headers.get("etag")!;
};
const add = (at: string) => {
  const r = addPromptSource(app.db, dataDir, { repoId, kind: "instagram", token: "tok-123", atUtc: at });
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-prompts-etag-"));
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
  const r = await createRepo(app, ada, { name: "box", visibility: "public" });
  if (!r.ok) throw new Error("repo");
  repoId = r.value.id;
  tok["admin"] = createToken(app.db, ada.id, "a", "admin").token;
  tok["ro"] = createToken(app.db, ada.id, "r", "ro").token;
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
  expect(await res.json()).toEqual({ items: [], next_cursor: null });
  const again = await get(tok["admin"]!, "ada/box/prompts", { "if-none-match": tag });
  expect(again.status).toBe(304);
  expect(again.headers.get("etag")).toBe(tag);
  expect(again.headers.get("cache-control")).toBe("private, no-cache");
  expect(again.headers.get("vary")).toContain("authorization, cookie");
  expect(again.headers.get("x-content-type-options")).toBe("nosniff");
  expect(again.headers.get("content-security-policy")).not.toBeNull();
  expect(await again.text()).toBe("");
});

test("adding, editing and removing a source each move the tag", async () => {
  const empty = await tagOf();
  const source = add("09:00");
  const added = await tagOf();
  expect(added).not.toBe(empty);
  expect((await get(tok["admin"]!, "ada/box/prompts", { "if-none-match": empty })).status).toBe(200);
  app.db.query("UPDATE prompt_source SET last_said = 'no new Reel' WHERE id = ?1").run(source.id);
  const edited = await tagOf();
  expect(edited).not.toBe(added);
  expect((await get(tok["admin"]!, "ada/box/prompts", { "if-none-match": edited })).status).toBe(304);
  expect(removePromptSource(app.db, source.id)).toBe(true);
  expect(listPromptSources(app.db, repoId)).toHaveLength(0);
  expect(await tagOf()).toBe(empty);
});

test("a token short of admin, a non-admin and a missing repository answer as before, with no tag, even for *", async () => {
  add("10:00");
  for (const [token, path, status] of [
    [tok["ro"]!, "ada/box/prompts", 403],
    [tok["bob"]!, "ada/box/prompts", 404],
    [tok["admin"]!, "ada/nope/prompts", 404],
    [null, "ada/box/prompts", 401],
  ] as const) {
    const res = await get(token, path, { "if-none-match": "*" });
    expect(res.status).toBe(status);
    expect(res.headers.get("etag")).toBeNull();
  }
});
