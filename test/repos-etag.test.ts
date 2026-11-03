/** GET /api/v1/repos is tagged and answers a repeat 304 until a listed repository changes (#9115). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createIssue } from "../src/core/issues.ts";
import { updateRepoSettings, type Repo } from "../src/core/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let alice: User;
let bob: User;
let tokens: Record<string, string>;
let open: Repo;

const get = (who: string | undefined, etag?: string, path = "/api/v1/repos") =>
  fetch(`${servers.url}${path}`, {
    headers: {
      ...(who === undefined ? {} : { authorization: `Bearer ${tokens[who]}` }),
      ...(etag === undefined ? {} : { "if-none-match": etag }),
    },
  });
const tagOf = async (who: string | undefined, path?: string) => {
  const res = await get(who, undefined, path);
  await res.arrayBuffer();
  expect(res.status).toBe(200);
  return res.headers.get("etag")!;
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-repos-etag-"));
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
  bob = await mk("bob");
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

describe("GET /api/v1/repos etag", () => {
  test("carries a weak tag, private no-cache and vary", async () => {
    const res = await get(undefined);
    await res.arrayBuffer();
    expect(res.headers.get("etag")).toMatch(/^W\/"/);
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("vary")).toContain("authorization, cookie");
  });

  test("a repeat is a 304 with no body", async () => {
    const tag = await tagOf("alice");
    const res = await get("alice", tag);
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    expect(res.headers.get("etag")).toBe(tag);
  });

  test("the cursor and limit are part of the tag", async () => {
    const a = await tagOf("alice");
    expect(await tagOf("alice", "/api/v1/repos?limit=1")).not.toBe(a);
  });

  test("a new repository makes the next answer a 200 with a new tag", async () => {
    const tag = await tagOf("alice");
    const made = await createRepo(app, alice, { name: "fresh", visibility: "public" });
    if (!made.ok) throw new Error("repo");
    const res = await get("alice", tag);
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).not.toBe(tag);
    expect(JSON.stringify(await res.json())).toContain("fresh");
  });

  test("a push changes the tag", async () => {
    const tag = await tagOf(undefined);
    app.bus.append({ kind: "push", repoId: open.id, actorId: alice.id, payload: {} });
    expect(await tagOf(undefined)).not.toBe(tag);
  });

  test("a rename changes the tag", async () => {
    const tag = await tagOf(undefined);
    app.db.query("UPDATE repo SET name = 'opened' WHERE id = ?1").run(open.id);
    expect(await tagOf(undefined)).not.toBe(tag);
  });

  test("turning a listed repository private changes an anonymous viewer's tag", async () => {
    const tag = await tagOf(undefined);
    updateRepoSettings(app.db, open, { visibility: "private" });
    const res = await get(undefined, tag);
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).not.toBe(tag);
  });

  test("viewers who see different lists never share a tag", async () => {
    const [a, b, anon] = [await tagOf("alice"), await tagOf("bob"), await tagOf(undefined)];
    expect(new Set([a, b, anon]).size).toBe(3);
    expect((await get("bob", a)).status).toBe(200);
    expect((await get(undefined, a)).status).toBe(200);
  });

  test("a private repository moves no tag for a viewer who cannot see it", async () => {
    const tag = await tagOf("bob");
    const made = await createRepo(app, alice, { name: "hidden", visibility: "private" });
    if (!made.ok) throw new Error("repo");
    expect((await get("bob", tag)).status).toBe(304);
  });

  test("filing a sealed report moves no tag; an open issue does", async () => {
    const fresh = app.db.query<{ id: string }, []>("SELECT id FROM repo WHERE name = 'fresh'").get()!;
    const [anon, other] = [await tagOf(undefined), await tagOf("bob")];
    const sealed = createIssue(app.db, { repoId: fresh.id, authorId: alice.id, title: "hole", sealed: true });
    if (!sealed.ok) throw new Error("issue");
    expect((await get(undefined, anon)).status).toBe(304);
    expect((await get("bob", other)).status).toBe(304);
    const plain = createIssue(app.db, { repoId: fresh.id, authorId: alice.id, title: "bug" });
    if (!plain.ok) throw new Error("issue");
    expect((await get(undefined, anon)).status).toBe(200);
  });
});
