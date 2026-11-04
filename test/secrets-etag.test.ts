/** GET /api/v1/secrets/:scope carries a weak ETag and answers a repeat with 304 until a secret in that scope moves (#9200). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { putSecret, removeSecret } from "../src/actions/secrets.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir = "";
let app: App, servers: Servers;
let alice: any;
let adminTok = "", readTok = "", otherTok = "";
const get = (path: string, tok: string, headers: Record<string, string> = {}) =>
  fetch(`${servers.url}/api/v1/secrets/${path}`, {
    headers: { authorization: `Bearer ${tok}`, ...headers },
  });
const tagOf = async (path: string) => {
  const res = await get(path, adminTok);
  expect(res.status).toBe(200);
  await res.text();
  return res.headers.get("etag")!;
};
async function changed(path: string, before: string, what: string): Promise<string> {
  const res = await get(path, adminTok, { "if-none-match": before });
  expect(res.status, what).toBe(200);
  await res.text();
  const tag = res.headers.get("etag")!;
  expect(tag, what).not.toBe(before);
  return tag;
}
async function still(path: string, tag: string, what: string): Promise<void> {
  const res = await get(path, adminTok, { "if-none-match": tag });
  expect(res.status, what).toBe(304);
  await res.text();
}
// updated_at has millisecond resolution; a replace in the same millisecond would be the same body.
const tick = () => Bun.sleep(5);

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-secrets-etag-"));
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
  alice = await mk("alice", true);
  const bob = await mk("bob", false);
  for (const name of ["a", "b"]) {
    const r = await createRepo(app, alice, { name, visibility: "public" });
    if (!r.ok) throw new Error("repo");
  }
  adminTok = createToken(app.db, alice.id, "t", "admin").token;
  readTok = createToken(app.db, alice.id, "r", "ro").token;
  otherTok = createToken(app.db, bob.id, "o", "admin").token;
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("200 carries a weak tag, private no-cache and vary; a repeat is a bodiless 304 with the floor headers", async () => {
  expect(putSecret(app, alice, "forge", "", "TOKEN", "s3cr3t-value").ok).toBe(true);
  const res = await get("forge", adminTok);
  expect(res.status).toBe(200);
  const tag = res.headers.get("etag")!;
  expect(tag).toMatch(/^W\//);
  expect(res.headers.get("cache-control")).toBe("private, no-cache");
  expect(res.headers.get("vary")).toContain("authorization, cookie");
  expect(res.headers.get("content-type")).toBe("application/json");
  const text = await res.text();
  expect(text).not.toContain("s3cr3t-value");
  const parsed = JSON.parse(text) as { items: { name: string }[]; next_cursor: null };
  expect(parsed.items.map((i) => i.name)).toEqual(["TOKEN"]);
  expect(parsed.next_cursor).toBeNull();
  const again = await get("forge", adminTok, { "if-none-match": tag });
  expect(again.status).toBe(304);
  expect(again.headers.get("etag")).toBe(tag);
  expect(again.headers.get("cache-control")).toBe("private, no-cache");
  expect(again.headers.get("vary")).toContain("authorization, cookie");
  expect(again.headers.get("x-content-type-options")).toBe("nosniff");
  expect(again.headers.get("content-security-policy")).not.toBeNull();
  expect(again.headers.get("referrer-policy")).not.toBeNull();
  expect(await again.text()).toBe("");
});

test("a secret set, replaced and removed in the scope each move the tag", async () => {
  let tag = await tagOf("forge");
  await tick();
  expect(putSecret(app, alice, "forge", "", "OTHER", "v1").ok).toBe(true);
  tag = await changed("forge", tag, "set");
  await tick();
  expect(putSecret(app, alice, "forge", "", "OTHER", "v2").ok).toBe(true);
  tag = await changed("forge", tag, "replaced");
  expect(removeSecret(app, alice, "forge", "", "OTHER").ok).toBe(true);
  await changed("forge", tag, "removed");
});

test("a change in another scope or ref leaves the tag; a change in this ref moves it", async () => {
  expect(putSecret(app, alice, "repo", "alice/a", "KEY", "x").ok).toBe(true);
  const forge = await tagOf("forge");
  const a = await tagOf("repo?ref=alice/a");
  await tick();
  expect(putSecret(app, alice, "repo", "alice/b", "KEY", "y").ok).toBe(true);
  await still("forge", forge, "another scope");
  await still("repo?ref=alice/a", a, "another ref");
  await tick();
  expect(putSecret(app, alice, "repo", "alice/a", "KEY", "z").ok).toBe(true);
  await changed("repo?ref=alice/a", a, "this ref");
  await still("forge", forge, "repo change leaves forge");
});

test("viewers shown different bodies never share a tag", async () => {
  const a = await get("repo?ref=alice/a", adminTok);
  const b = await get("repo?ref=alice/b", adminTok);
  const aText = await a.text();
  const bText = await b.text();
  expect(aText).not.toBe(bText);
  const aTag = a.headers.get("etag")!;
  expect(aTag).not.toBe(b.headers.get("etag"));
  const replay = await get("repo?ref=alice/b", adminTok, { "if-none-match": aTag });
  expect(replay.status).toBe(200);
  expect(await replay.text()).toBe(bText);
});

test("a short token, a non-admin and an unknown scope answer as before, with no ETag, even with If-None-Match: *", async () => {
  const cases: [string, string][] = [
    ["forge", readTok],
    ["forge", otherTok],
    ["nope", adminTok],
    ["repo?ref=alice/missing", adminTok],
  ];
  for (const [path, tok] of cases) {
    const plain = await get(path, tok);
    const plainText = await plain.text();
    const starred = await get(path, tok, { "if-none-match": "*" });
    const starredText = await starred.text();
    expect(plain.status, path).toBeGreaterThanOrEqual(400);
    expect(starred.status, path).toBe(plain.status);
    expect(starredText, path).toBe(plainText);
    expect(plain.headers.get("etag"), path).toBeNull();
    expect(starred.headers.get("etag"), path).toBeNull();
  }
});
