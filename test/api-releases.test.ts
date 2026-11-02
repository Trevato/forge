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

  test("the OpenAPI document lists the route", async () => {
    const doc = (await (await fetch(`${servers.url}/api/v1/openapi.json`)).json()) as any;
    expect(doc.paths["/api/v1/releases"].get).toBeDefined();
  });
});
