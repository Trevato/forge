/** A mistyped repository address offers the nearest repositories the viewer can see (#10969). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";
import { editDistance } from "../src/text/edit_distance.ts";

let dir = "";
let app: ReturnType<typeof createApp>;
let servers: Awaited<ReturnType<typeof serve>>;
/** Statements the page of a found repository makes; a change to it is a change to this number. */
const FOUND_QUERIES = 41;
const BARE_404_QUERIES = 3; // a 404 with no owner/name to suggest from
const NEAR_404_QUERIES = 18; // the same 404 for a mistyped repository
const cookies: Record<string, string> = {};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-dym-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const users: Record<string, Awaited<ReturnType<typeof createUser>>> = {};
  for (const [username, first] of [["trevato", true], ["stranger", false]] as const) {
    users[username] = await createUser(app.db, {
      origin: "seed", trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", adminIfFirst: first,
    });
    const res = await fetch(servers.url + "/signin", {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: new URLSearchParams({ username, password: "a-good-passphrase" }),
    });
    cookies[username] = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  }
  const owner = (users.trevato as any).value ?? users.trevato;
  await createRepo(app, owner, { name: "forge", visibility: "public" });
  await createRepo(app, owner, { name: "secretforge", visibility: "private" });
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const get = async (path: string, who?: string) => {
  const res = await fetch(servers.url + path, { headers: who ? { cookie: cookies[who]! } : {} });
  return { res, body: await res.text() };
};

test("edit distance is bounded", () => {
  expect(editDistance("forge", "forg", 2)).toBe(1);
  expect(editDistance("abc", "xyz", 2)).toBe(3);
  expect(editDistance("a", "abcdef", 2)).toBe(3);
});

test("a typo in the name or the owner lists the close repository as a link, still a 404", async () => {
  for (const path of ["/trevato/forg", "/trevto/forge"]) {
    const { res, body } = await get(path, "stranger");
    expect(res.status).toBe(404);
    expect(body).toContain('<a href="/trevato/forge">trevato/forge</a>');
    expect(res.headers.get("content-security-policy")).toBeTruthy();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  }
});

test("nothing is listed when nothing is close", async () => {
  const { res, body } = await get("/zzzzzz/qqqqqqqq", "stranger");
  expect(res.status).toBe(404);
  expect(body).not.toContain("Did you mean");
});

test("a private repository is suggested to its owner and never to a stranger or anonymous", async () => {
  for (const who of ["stranger", undefined]) {
    const { body } = await get("/trevato/secretforg", who);
    expect(body).not.toContain("secretforge");
  }
  const mine = await get("/trevato/secretforg", "trevato");
  expect(mine.res.status).toBe(404);
  expect(mine.body).toContain('href="/trevato/secretforge"');
});

/** Every statement a request makes, whichever way it is prepared. */
async function queriesFor(path: string, who: string): Promise<number> {
  let n = 0;
  const db = app.db as unknown as Record<string, unknown>;
  const saved = { query: db.query, prepare: db.prepare };
  for (const k of ["query", "prepare"] as const) {
    const orig = (saved[k] as (...a: unknown[]) => unknown).bind(app.db);
    db[k] = (...a: unknown[]) => (n++, orig(...a));
  }
  try {
    await get(path, who);
  } finally {
    db.query = saved.query;
    db.prepare = saved.prepare;
  }
  return n;
}

test("the suggestion costs queries on a 404 only: the 200 path's count is pinned", async () => {
  await get("/trevato/forge", "stranger"); // warm
  const found = await queriesFor("/trevato/forge", "stranger");
  const missed = await queriesFor("/trevato/forg", "stranger");
  const bare = await queriesFor("/api-nothing-here/a/b/c/d", "stranger");
  // Pinned exactly, so a query added to or hidden in the 200 path changes a number.
  expect(found).toBe(FOUND_QUERIES);
  expect(bare).toBe(BARE_404_QUERIES);
  // The suggestion's lookups are the 404's alone, and they show as the extra.
  expect(missed).toBe(NEAR_404_QUERIES);
  expect(missed).toBeGreaterThan(bare);
});

test("the shared lookup, which the terminal's owner/name prompt uses, hides what the viewer cannot read", async () => {
  const { nearRepos } = await import("../src/core/near_repos.ts");
  const { getUserByName } = await import("../src/core/users.ts");
  const stranger = getUserByName(app.db, "stranger");
  const owner = getUserByName(app.db, "trevato");
  expect(nearRepos(app.db, stranger, "trevato", "secretforg")).toEqual([]);
  expect(nearRepos(app.db, owner, "trevato", "secretforg").map((r) => r.name)).toEqual(["secretforge"]);
  expect(nearRepos(app.db, undefined, "", "x")).toEqual([]);
});
