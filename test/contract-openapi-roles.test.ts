import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { ROUTES } from "../src/contract/openapi.ts";
import { openapiRoute } from "../src/contract/served.ts";
import { Router } from "../src/http/router.ts";

type Op = { "x-role": string; tags: string[] };
type Doc = { paths: Record<string, Record<string, Op>>; tags: { name: string }[] };

const router = new Router<(ctx: any) => Response>();
openapiRoute(router as never);
const handler = (router as any).match("GET", "/contract/openapi.json").handler;
const ask = (user: { isAdmin: boolean } | undefined, q = "", headers: Record<string, string> = {}): Response => {
  const url = new URL(`https://roles.test/contract/openapi.json${q}`);
  return handler({ url, request: new Request(url.href, { headers }), auth: { user, via: user ? "token" : "none" } });
};
const ops = (doc: Doc): Op[] => Object.values(doc.paths).flatMap((o) => Object.values(o));
const roles = (doc: Doc): Set<string> => new Set(ops(doc).map((o) => o["x-role"]));
const count = (...rs: string[]): number => ROUTES.filter((r) => rs.includes(r.role)).length;

test("anonymous sees anonymous rows, a member adds member rows, an admin sees all three", async () => {
  const anon = (await ask(undefined).json()) as Doc;
  const member = (await ask({ isAdmin: false }).json()) as Doc;
  const admin = (await ask({ isAdmin: true }).json()) as Doc;
  expect([...roles(anon)]).toEqual(["anonymous"]);
  expect([...roles(member)].sort()).toEqual(["anonymous", "member"]);
  expect([...roles(admin)].sort()).toEqual(["admin", "anonymous", "member"]);
  expect(ops(anon).length).toBe(count("anonymous"));
  expect(ops(member).length).toBe(count("anonymous", "member"));
  expect(ops(admin).length).toBe(ROUTES.length);
  // No admin path reaches the first two, nor a tag only admin rows carry.
  const adminOnly = ROUTES.filter((r) => r.role === "admin").map((r) => `${r.method} ${r.path}`);
  expect(adminOnly.length).toBeGreaterThan(0);
  for (const doc of [anon, member]) {
    const seen = new Set(Object.entries(doc.paths).flatMap(([p, o]) => Object.keys(o).map((m) => `${m} ${p}`)));
    for (const row of adminOnly) expect(seen.has(row), row).toBe(false);
    const used = new Set(ops(doc).flatMap((o) => o.tags));
    expect(doc.tags.every((t) => used.has(t.name))).toBe(true);
  }
});

test("each role has its own tag; only the anonymous answer is public, and every answer varies on credentials", async () => {
  const [a, m, ad] = [ask(undefined), ask({ isAdmin: false }), ask({ isAdmin: true })];
  const tags = [a, m, ad].map((r) => r.headers.get("etag"));
  expect(new Set(tags).size).toBe(3);
  expect(a.headers.get("cache-control")).toStartWith("public");
  expect(m.headers.get("cache-control")).toStartWith("private");
  expect(ad.headers.get("cache-control")).toStartWith("private");
  for (const r of [a, m, ad]) expect(r.headers.get("vary")).toContain("authorization, cookie");
  // The admin's tag does not answer 304 to an anonymous asker.
  expect(ask(undefined, "", { "if-none-match": tags[2]! }).status).toBe(200);
  expect(ask({ isAdmin: true }, "", { "if-none-match": tags[2]! }).status).toBe(304);
});

test("?tag= slices per role", async () => {
  const tag = ROUTES.find((r) => r.role === "admin")!;
  const name = ((await ask({ isAdmin: true }).json()) as Doc).paths[tag.path]![tag.method]!.tags[0]!;
  const anon = (await ask(undefined, `?tag=${name}`).json()) as Doc;
  const admin = (await ask({ isAdmin: true }, `?tag=${name}`).json()) as Doc;
  expect(roles(anon).has("admin")).toBe(false);
  expect(admin.paths[tag.path]?.[tag.method]).toBeDefined();
  for (const o of [...ops(anon), ...ops(admin)]) expect(o.tags).toEqual([name]);
});

describe("over HTTP, a bearer token reaches the cut (#11286)", () => {
  let dir = "";
  let app: App;
  let servers: Servers;
  const tokens: Record<string, string> = {};
  const read = (token?: string) =>
    fetch(`${servers.url}/contract/openapi.json`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-openapi-roles-"));
    app = createApp({ dataDir: dir, port: 0 });
    servers = await serve(app);
    for (const [name, isAdmin] of [["carol", true], ["bob", false]] as const) {
      const made = await createUser(app.db, { origin: "seed", trusted: true, username: name, email: `${name}@f.dev`, password: "a-good-passphrase", isAdmin });
      if (!made.ok) throw new Error(made.error);
      tokens[name] = createToken(app.db, made.value.id, "t", "ro").token;
    }
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("anonymous, a member's token and an admin's token each get their own rows and cache rule", async () => {
    const [anon, member, admin] = await Promise.all([read(), read(tokens.bob), read(tokens.carol)]);
    expect(anon.headers.get("cache-control")).toStartWith("public");
    expect(member.headers.get("cache-control")).toStartWith("private");
    expect(admin.headers.get("cache-control")).toStartWith("private");
    expect([...roles((await anon.json()) as Doc)]).toEqual(["anonymous"]);
    expect([...roles((await member.json()) as Doc)].sort()).toEqual(["anonymous", "member"]);
    expect(ops((await admin.json()) as Doc).length).toBe(ROUTES.length);
    // A token the forge does not know is no one: the anonymous cut.
    const stranger = await read("forge_not_a_real_token");
    expect([401, 200]).toContain(stranger.status);
    if (stranger.status === 200) expect([...roles((await stranger.json()) as Doc)]).toEqual(["anonymous"]);
  });
});
