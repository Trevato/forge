/** GET /api/v1/user/repos is tagged and answers a repeat 304 until one of the viewer's repositories changes (#9225). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { updateRepoSettings, type Repo } from "../src/core/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let alice: User;
let tokens: Record<string, string>;
let open: Repo;

const get = (who: string | undefined, etag?: string, query = "") =>
  fetch(`${servers.url}/api/v1/user/repos${query}`, {
    headers: {
      ...(who === undefined ? {} : { authorization: `Bearer ${tokens[who]}` }),
      ...(etag === undefined ? {} : { "if-none-match": etag }),
    },
  });
const tagOf = async (who: string, query?: string) => {
  const res = await get(who, undefined, query);
  await res.arrayBuffer();
  expect(res.status).toBe(200);
  return res.headers.get("etag")!;
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-own-repos-etag-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, first = false) => {
    const r = await createUser(app.db, {
      origin: "seed", trusted: true, username, allowReserved: true,
      email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first,
    });
    if (!r.ok) throw new Error(r.error);
    promote(app.db, r.value);
    return r.value;
  };
  await mk("root", true);
  alice = await mk("alice");
  const bob = await mk("bob");
  tokens = {
    alice: createToken(app.db, alice.id, "t", "rw").token,
    bob: createToken(app.db, bob.id, "t", "rw").token,
  };
  const o = await createRepo(app, alice, { name: "open", visibility: "public" });
  const s = await createRepo(app, alice, { name: "secret", visibility: "private" });
  const b = await createRepo(app, bob, { name: "bobs", visibility: "private" });
  if (!o.ok || !s.ok || !b.ok) throw new Error("repos");
  open = o.value;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("GET /api/v1/user/repos etag", () => {
  test("carries a weak tag, private no-cache and vary", async () => {
    const res = await get("alice");
    await res.arrayBuffer();
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toMatch(/^W\//);
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("vary")).toContain("authorization, cookie");
  });

  test("a repeat is a 304 with the same headers, no body and the security floor", async () => {
    const first = await get("alice");
    await first.arrayBuffer();
    const tag = first.headers.get("etag")!;
    const res = await get("alice", tag);
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    expect(res.headers.get("etag")).toBe(tag);
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("vary")).toContain("authorization, cookie");
    expect(res.headers.get("x-total-count")).toBe(first.headers.get("x-total-count"));
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).not.toBeNull();
  });

  test("no session is a 401 with no tag, even with If-None-Match: *", async () => {
    const res = await get(undefined, "*");
    expect(res.status).toBe(401);
    expect(res.headers.get("etag")).toBeNull();
  });

  test("page and limit change the tag", async () => {
    const [a, b, c] = [await tagOf("alice"), await tagOf("alice", "?limit=1"), await tagOf("alice", "?limit=1&page=2")];
    expect(new Set([a, b, c]).size).toBe(3);
    expect((await get("alice", b, "?limit=1&page=2")).status).toBe(200);
  });

  test("two viewers never share a tag", async () => {
    const [a, b] = [await tagOf("alice"), await tagOf("bob")];
    expect(a).not.toBe(b);
    expect((await get("bob", a)).status).toBe(200);
  });

  test("a push changes the tag", async () => {
    const tag = await tagOf("alice");
    app.bus.append({ kind: "push", repoId: open.id, actorId: alice.id, payload: {} });
    expect((await get("alice", tag)).status).toBe(200);
  });

  test("creating, renaming and deleting a repository each change the tag", async () => {
    let tag = await tagOf("alice");
    const made = await createRepo(app, alice, { name: "fresh", visibility: "public" });
    if (!made.ok) throw new Error("repo");
    expect((await get("alice", tag)).status).toBe(200);
    tag = await tagOf("alice");
    app.db.run("UPDATE repo SET name = 'renamed' WHERE id = ?", [made.value.id]);
    expect((await get("alice", tag)).status).toBe(200);
    tag = await tagOf("alice");
    app.db.run("DELETE FROM repo WHERE id = ?", [made.value.id]);
    expect((await get("alice", tag)).status).toBe(200);
  });

  test("another owner's repository does not change it", async () => {
    const tag = await tagOf("alice");
    const bob = app.db.query<{ id: string }, []>("SELECT id FROM user WHERE username='bob'").get()!;
    const made = await createRepo(app, { id: bob.id, username: "bob" } as User, { name: "elsewhere", visibility: "public" });
    if (!made.ok) throw new Error("repo");
    expect((await get("alice", tag)).status).toBe(304);
  });

  test("turning a repository private changes the tag", async () => {
    const tag = await tagOf("alice");
    updateRepoSettings(app.db, open, { visibility: "private" });
    expect((await get("alice", tag)).status).toBe(200);
  });
});
