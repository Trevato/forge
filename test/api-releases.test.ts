/** `GET /api/v1/releases` is MCP `releases` over HTTP: the same rows, the same gate, `?shipped=true` open to anyone. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { recordRelease } from "../src/release/record.ts";

const LIVE = "a".repeat(40);

describe("GET /api/v1/releases", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let admin: string;
  let bob: string;
  let repoId: Parameters<typeof recordRelease>[1]["repoId"];
  const saved = process.env["FORGE_COMMIT"];
  const get = (query: string, token?: string) =>
    fetch(`${servers.url}/api/v1/releases${query}`, token ? { headers: { authorization: `Bearer ${token}` } } : {});

  beforeAll(async () => {
    process.env["FORGE_COMMIT"] = LIVE;
    dataDir = await mkdtemp(join(tmpdir(), "forge-api-releases-"));
    app = createApp({ dataDir, port: 0, forgeRepo: "alice/forge" });
    servers = await serve(app);
    const mk = async (username: string, first = false) => {
      const u = await createUser(app.db, {
        origin: "seed", trusted: true, username,
        email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first,
      });
      if (!u.ok) throw new Error(u.error);
      return u.value;
    };
    const alice = await mk("alice", true);
    const b = await mk("bob");
    admin = createToken(app.db, alice.id, "a", "admin").token;
    bob = createToken(app.db, b.id, "b", "admin").token;
    const made = await createRepo(app, alice, { name: "forge", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repoId = made.value.id;
    recordRelease(app.db, { sha: LIVE, repoId: made.value.id, pullNumber: 2, ok: true, line: "ok" });
  }, 30_000);

  afterAll(async () => {
    if (saved === undefined) delete process.env["FORGE_COMMIT"];
    else process.env["FORGE_COMMIT"] = saved;
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("?shipped=true answers anyone, no token", async () => {
    const res = await get("?shipped=true");
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(Array.isArray(body.live)).toBe(true);
    expect(Array.isArray(body.onItsWay)).toBe(true);
    expect(body.commit).toBe(LIVE);
  });

  test("an administrator gets the kept releases, the live one marked", async () => {
    const res = await get("", admin);
    expect(res.status).toBe(200);
    const { items }: any = await res.json();
    expect(items.map((i: any) => i.sha)).toEqual(["a".repeat(12)]);
    expect(items[0].live).toBe(true);
    expect(items[0].pull).toEqual({ repo: "alice/forge", number: 2 });
  });

  test("a stranger and an anonymous caller are refused in words", async () => {
    for (const token of [bob, undefined]) {
      const res = await get("", token);
      expect(res.status).toBe(403);
      const body: any = await res.json();
      expect(body.error).toBe("forbidden");
      expect(body.message).toContain("release history");
    }
  });

  test("any other shipped value is 422 invalid_shipped", async () => {
    for (const v of ["maybe", "false", ""]) {
      const res = await get(`?shipped=${v}`, admin);
      expect(res.status).toBe(422);
      expect(((await res.json()) as any).error).toBe("invalid_shipped");
    }
  });

  test("each 200 carries an etag; a repeat gets 304; a new shipped release changes the tag", async () => {
    const again = async (query: string, token?: string) => {
      const first = await get(query, token);
      expect(first.status).toBe(200);
      const etag = first.headers.get("etag")!;
      expect(etag).toMatch(/^W\//);
      await first.text();
      const headers: Record<string, string> = { "if-none-match": etag };
      if (token) headers["authorization"] = `Bearer ${token}`;
      const second = await fetch(`${servers.url}/api/v1/releases${query}`, { headers });
      expect(second.status).toBe(304);
      expect(second.headers.get("etag")).toBe(etag);
      expect(await second.text()).toBe("");
      return { etag, first };
    };
    const shipped = await again("?shipped=true");
    expect(shipped.first.headers.get("cache-control")).toBe("public, max-age=60");
    const kept = await again("", admin);
    expect(kept.first.headers.get("cache-control")).toBe("private, no-cache");
    expect(kept.first.headers.get("vary")).toStartWith("authorization, cookie");

    // A reader now refused never gets a 304, even holding the tag.
    const refused = await fetch(`${servers.url}/api/v1/releases`, {
      headers: { authorization: `Bearer ${bob}`, "if-none-match": kept.etag },
    });
    expect(refused.status).toBe(403);
    expect(refused.headers.get("etag")).toBeNull();

    recordRelease(app.db, { sha: "b".repeat(40), repoId, pullNumber: 3, ok: true, line: "ok" });
    // What ?shipped=true reads is the merged pulls: a new one landing changes its tag.
    const author = app.db.query<{ id: string }, []>("SELECT id FROM user LIMIT 1").get()!.id;
    const branch = app.db.query<{ default_branch: string }, [string]>("SELECT default_branch FROM repo WHERE id = ?1").get(repoId as string)!.default_branch;
    app.db.query(`INSERT INTO issue (id, repo_id, number, kind, title, author_id, state) VALUES ('ship-new', ?1, 3, 'pull', 'A new landing', ?2, 'closed')`).run(repoId as string, author);
    app.db.query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at, merged_oid) VALUES ('ship-new', ?1, 'b', 'base', '', '2026-10-09T10:00:00.000Z', 'oid-new')`).run(branch);
    const newShipped = await fetch(`${servers.url}/api/v1/releases?shipped=true`, { headers: { "if-none-match": shipped.etag } });
    expect(newShipped.status).toBe(200);
    expect(newShipped.headers.get("etag")).not.toBe(shipped.etag);
    const after = await get("", admin);
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(kept.etag);
  });

  test("an invalid shipped carries no etag", async () => {
    const res = await get("?shipped=maybe");
    expect(res.status).toBe(422);
    expect(res.headers.get("etag")).toBeNull();
  });

  test("the OpenAPI document lists the route", async () => {
    const doc = (await (await fetch(`${servers.url}/api/v1/openapi.json`)).json()) as any;
    expect(doc.paths["/api/v1/releases"].get).toBeDefined();
  });
});
