/** GET /api/v1/boards, /boards/pins and /boards/:slug carry an ETag; a repeat is a 304 until a board or its pins change. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { writeBoard } from "../src/actions/boards.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

const panel = (title: string) => ({ title, chart: "line", query: { source: "runs", aggregate: "count", groupBy: "kind" }, w: 1, h: 1 });
const board = (title: string, panels: unknown[]) => ({ title, range: "all", refresh: "off", panels });

describe("boards ETag", () => {
  let dir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  const tok: Record<string, string> = {};

  const req = (path: string, who: string | null, extra: Record<string, string> = {}, method = "GET", body?: unknown) =>
    fetch(`${servers.url}${path}`, {
      method,
      headers: {
        ...(who ? { authorization: `Bearer ${tok[who]}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...extra,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const get = (path: string, who: string | null, extra: Record<string, string> = {}) => req(path, who, extra);
  const pin = (who: string, op: string, slug: string, title: string) =>
    req("/api/v1/boards/pins", who, {}, "POST", { op, slug, title });
  /** Fetch, then assert that holding the old tag now gets a new body and tag. */
  const moved = async (path: string, who: string, old: string) => {
    const out = await get(path, who, { "if-none-match": old });
    expect(out.status).toBe(200);
    const tag = out.headers.get("etag")!;
    expect(tag).not.toBe(old);
    await out.text();
    return tag;
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-boards-etag-"));
    app = createApp({ dataDir: dir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string, adminIfFirst?: boolean): Promise<User> => {
      const r = await createUser(app.db, {
        origin: "seed", trusted: true, username, email: `${username}@forge.local`,
        password: "a-good-passphrase", ...(adminIfFirst ? { adminIfFirst } : {}),
      });
      if (!r.ok) throw new Error(r.error);
      return r.value;
    };
    alice = await mk("alice", true);
    const carol = await mk("carol");
    app.db.run("UPDATE user SET is_admin = 1 WHERE id = ?", [carol.id]);
    const bob = await mk("bob");
    tok.alice = createToken(app.db, alice.id, "t", "admin").token;
    tok.carol = createToken(app.db, carol.id, "t", "admin").token;
    tok.bob = createToken(app.db, bob.id, "t", "admin").token;
    const w = await writeBoard(app, alice, "mine", board("Mine", [panel("Pin A"), panel("Pin B")]));
    if (!w.ok) throw new Error(JSON.stringify(w.error));
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  for (const path of ["/api/v1/boards", "/api/v1/boards/pins", "/api/v1/boards/mine"]) {
    test(`${path}: 200 with a weak tag, then 304 with the same headers and no body`, async () => {
      const first = await get(path, "alice");
      expect(first.status).toBe(200);
      const tag = first.headers.get("etag")!;
      expect(tag).toMatch(/^W\/"/);
      expect(first.headers.get("cache-control")).toBe("private, no-cache");
      expect(first.headers.get("vary")).toContain("authorization, cookie");
      expect(first.headers.get("content-type")).toContain("application/json");
      JSON.parse(await first.text());
      const again = await get(path, "alice", { "if-none-match": tag });
      expect(again.status).toBe(304);
      expect(again.headers.get("etag")).toBe(tag);
      expect(again.headers.get("cache-control")).toBe("private, no-cache");
      expect(again.headers.get("vary")).toContain("authorization, cookie");
      expect(again.headers.get("x-content-type-options")).toBe("nosniff");
      expect(again.headers.get("referrer-policy")).not.toBeNull();
      expect(await again.text()).toBe("");
    });
  }

  test("the list moves when a board is created, renamed or deleted", async () => {
    let tag = (await get("/api/v1/boards", "alice")).headers.get("etag")!;
    expect((await req("/api/v1/boards/other", "alice", {}, "PUT", board("Other", []))).status).toBe(200);
    tag = await moved("/api/v1/boards", "alice", tag);
    expect((await req("/api/v1/boards/other", "alice", {}, "PUT", board("Other renamed", []))).status).toBe(200);
    tag = await moved("/api/v1/boards", "alice", tag);
    expect((await req("/api/v1/boards/other", "alice", {}, "DELETE")).status).toBe(200);
    await moved("/api/v1/boards", "alice", tag);
  });

  test("pins move when a pin is added or removed", async () => {
    let tag = (await get("/api/v1/boards/pins", "alice")).headers.get("etag")!;
    expect((await pin("alice", "pin", "mine", "Pin A")).status).toBe(200);
    tag = await moved("/api/v1/boards/pins", "alice", tag);
    expect((await pin("alice", "unpin", "mine", "Pin A")).status).toBe(200);
    await moved("/api/v1/boards/pins", "alice", tag);
  });

  test("a board moves when a panel on it is written, and each slug has its own tag", async () => {
    expect((await req("/api/v1/boards/second", "alice", {}, "PUT", board("Second", []))).status).toBe(200);
    const mine = (await get("/api/v1/boards/mine", "alice")).headers.get("etag")!;
    const second = (await get("/api/v1/boards/second", "alice")).headers.get("etag")!;
    expect(second).not.toBe(mine);
    expect((await get("/api/v1/boards/second", "alice", { "if-none-match": mine })).status).toBe(200);
    const written = await req("/api/v1/boards/mine", "alice", {}, "PUT", board("Mine", [panel("Pin A"), panel("Pin B"), panel("Pin C")]));
    expect(written.status).toBe(200);
    await moved("/api/v1/boards/mine", "alice", mine);
    expect((await get("/api/v1/boards/second", "alice", { "if-none-match": second })).status).toBe(304);
  });

  test("viewers shown different pins never share a tag", async () => {
    expect((await pin("alice", "pin", "mine", "Pin B")).status).toBe(200);
    const a = (await get("/api/v1/boards/pins", "alice")).headers.get("etag")!;
    const c = (await get("/api/v1/boards/pins", "carol")).headers.get("etag")!;
    expect(a).not.toBe(c);
    expect((await get("/api/v1/boards/pins", "carol", { "if-none-match": a })).status).toBe(200);
    expect((await get("/api/v1/boards/pins", "alice", { "if-none-match": c })).status).toBe(200);
  });

  test("no session, no admin and unknown boards answer as before, with no tag, even for *", async () => {
    const tag = (await get("/api/v1/boards/mine", "alice")).headers.get("etag")!;
    for (const path of ["/api/v1/boards", "/api/v1/boards/pins", "/api/v1/boards/mine"]) {
      for (const held of [tag, "*"]) {
        for (const who of [null, "bob"]) {
          const out = await get(path, who, { "if-none-match": held });
          expect([401, 403]).toContain(out.status);
          expect(out.headers.get("etag")).toBeNull();
        }
      }
    }
    for (const held of [tag, "*"]) {
      const out = await get("/api/v1/boards/nope", "alice", { "if-none-match": held });
      expect(out.status).toBe(404);
      expect(out.headers.get("etag")).toBeNull();
    }
  });

  test("sources and panel data carry no tag", async () => {
    expect((await get("/api/v1/boards/sources", "alice")).headers.get("etag")).toBeNull();
    const p = await get("/api/v1/boards/mine/panels/0", "alice");
    expect(p.status).toBe(200);
    expect(p.headers.get("etag")).toBeNull();
    expect(p.headers.get("cache-control")).toBe("private, no-store");
  });
});
