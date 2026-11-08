import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { isTokenScheme, tokenSecret } from "../src/http/token_header.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

/**
 * The edges of what another forge reads from this one (#8900): the `token`
 * scheme, `GET /api/v1/user/repos` paged, capped and private to its owner.
 */

quietLogs();

test("a token header holds a secret, or it is not a token header", () => {
  expect(tokenSecret("Bearer abc")).toBe("abc");
  expect(tokenSecret("token abc")).toBe("abc");
  expect(tokenSecret("token ")).toBeNull();
  expect(tokenSecret("Bearer    ")).toBeNull();
  expect(tokenSecret("token")).toBeNull();
  expect(tokenSecret("tokenabc")).toBeNull();
  expect(tokenSecret("Basic abc")).toBeNull();
  expect(isTokenScheme("token")).toBe(false);
  expect(isTokenScheme("token ")).toBe(true);
});

describe("the repositories a forge lists to another", () => {
  let dir = "";
  let app: App;
  let servers: Servers;
  let aliceToken = "";
  let bobToken = "";

  const get = (path: string, authorization?: string) =>
    fetch(`${servers.url}${path}`, authorization === undefined ? {} : { headers: { authorization } });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-origin-edges-"));
    // A tiny limit for this listener, so the token scheme's bucket can be seen.
    process.env["FORGE_RATE_LIMIT"] = "30";
    app = createApp({ dataDir: dir, port: 0 });
    servers = await serve(app);
    delete process.env["FORGE_RATE_LIMIT"];
    for (const name of ["alice", "bob"]) {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username: name,
        email: `${name}@forge.local`,
        password: "a-good-passphrase",
      });
      if (!made.ok) throw new Error(made.error);
    }
    const alice = getUserByName(app.db, "alice")!;
    aliceToken = createToken(app.db, alice.id, "t", "ro").token;
    bobToken = createToken(app.db, getUserByName(app.db, "bob")!.id, "t", "ro").token;
    const insert = app.db.query(
      `INSERT INTO repo (id, owner_id, name, visibility, description, default_branch) VALUES (?1, ?2, ?3, ?4, '', 'main')`,
    );
    app.db.transaction(() => {
      for (let i = 1; i <= 1005; i++)
        insert.run(`x${String(i).padStart(6, "0")}`, alice.id, `r${i}`, i === 500 ? "private" : "public");
    })();
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  test("a malformed token header is no one, and never a wrong slice", async () => {
    for (const header of ["token", "token ", "Bearer ", "tokenxyz", `tok ${aliceToken}`])
      expect((await get("/api/v1/user/repos", header)).status).toBe(401);
    expect((await get("/api/v1/user/repos", `token ${aliceToken}`)).status).toBe(200);
  });

  test("the token scheme and Bearer are one bucket under the rate limit", async () => {
    // Bob's own token: 30 a minute, shared by both spellings of the header.
    let refused = 0;
    for (let i = 0; i < 40; i++) {
      const r = await get("/api/v1/version", i % 2 === 0 ? `token ${bobToken}` : `Bearer ${bobToken}`);
      if (r.status === 429) refused++;
    }
    const after = await get("/api/v1/user/repos", `token ${bobToken}`);
    expect(refused).toBeGreaterThan(0);
    expect(after.status).toBe(429);
    expect((await get("/api/v1/user/repos", `Bearer ${bobToken}`)).status).toBe(429);
  });

  test("pages follow page and limit, with the total and the next link", async () => {
    const first = await get("/api/v1/user/repos?limit=10", `token ${aliceToken}`);
    expect(first.status).toBe(200);
    const rows = (await first.json()) as { full_name: string }[];
    expect(rows.length).toBe(10);
    expect(first.headers.get("x-total-count")).toBe("1000");
    const link = first.headers.get("link") ?? "";
    expect(link).toContain("page=2");
    expect(link).toContain('rel="next"');

    const second = (await (await get("/api/v1/user/repos?limit=10&page=2", `token ${aliceToken}`)).json()) as {
      full_name: string;
    }[];
    expect(second.length).toBe(10);
    expect(second.map((r) => r.full_name).filter((n) => rows.some((r) => r.full_name === n))).toEqual([]);

    const last = await get("/api/v1/user/repos?limit=100&page=10", `token ${aliceToken}`);
    expect(((await last.json()) as unknown[]).length).toBe(100);
    expect(last.headers.get("link")).toBeNull();
    const beyond = await get("/api/v1/user/repos?limit=100&page=11", `token ${aliceToken}`);
    expect(await beyond.json()).toEqual([]);
  });

  test("a limit over 100 is 100, and nonsense is the default", async () => {
    expect(((await (await get("/api/v1/user/repos?limit=5000", `token ${aliceToken}`)).json()) as unknown[]).length).toBe(100);
    expect(((await (await get("/api/v1/user/repos?limit=-3&page=abc", `token ${aliceToken}`)).json()) as unknown[]).length).toBe(50);
  });

  test("1005 owned repositories are read as 1000, and say so", async () => {
    const r = await get("/api/v1/user/repos?limit=1", `token ${aliceToken}`);
    expect(r.headers.get("x-total-count")).toBe("1000");
  });

  test("the private repository is in its owner's list only; a guest has no list", async () => {
    const names = async (auth: string) => {
      const all: string[] = [];
      for (let page = 1; page <= 10; page++) {
        const rows = (await (await get(`/api/v1/user/repos?limit=100&page=${page}`, auth)).json()) as { full_name: string }[];
        all.push(...rows.map((r) => r.full_name));
      }
      return all;
    };
    expect(await names(`token ${aliceToken}`)).toContain("alice/r500");
    const asBob = await get("/api/v1/user/repos?limit=100", `Basic ${Buffer.from("bob:a-good-passphrase").toString("base64")}`);
    expect(asBob.status).toBe(200);
    expect(await asBob.json()).toEqual([]);
    expect((await get("/api/v1/user/repos")).status).toBe(401);
  });
});
