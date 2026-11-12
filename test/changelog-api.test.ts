/** `GET /api/v1/changelog` and MCP `releases {shipped, repo}` answer the rows /changelog shows; a private repo's landing is never in them. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { forgetLive, keepLive } from "../src/release/landings.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("GET /api/v1/changelog", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let admin: string;
  const saved = process.env["FORGE_COMMIT"];
  const get = (query: string, token?: string) =>
    fetch(`${servers.url}/api/v1/changelog${query}`, token ? { headers: { authorization: `Bearer ${token}` } } : {});
  const mcp = async (args: object, token: string) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "releases", arguments: args } }),
    });
    const body: any = await res.json();
    return JSON.parse(body.result.content[0].text);
  };

  beforeAll(async () => {
    process.env["FORGE_COMMIT"] = "a".repeat(40);
    dataDir = await mkdtemp(join(tmpdir(), "forge-changelog-api-"));
    app = createApp({ dataDir, port: 0, forgeRepo: "alice/forge" });
    servers = await serve(app);
    const u = await createUser(app.db, {
      origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
    admin = createToken(app.db, u.value.id, "a", "admin").token;
    const insertIssue = app.db.query(
      `INSERT INTO issue (id, repo_id, number, kind, title, author_id, state) VALUES (?1, ?2, ?3, 'pull', ?4, ?5, 'closed')`,
    );
    const insertPull = app.db.query(
      `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at, merged_oid) VALUES (?1, ?2, 'b', 'base', '', ?3, ?4)`,
    );
    let k = 0;
    for (const [name, visibility, title] of [
      ["forge", "public", "Public landing"],
      ["notes", "public", "Other repo landing"],
      ["secret", "private", "Private landing"],
    ] as const) {
      const made = await createRepo(app, u.value, { name, visibility });
      if (!made.ok) throw new Error(String(made.error));
      k++;
      insertIssue.run(`i${k}`, made.value.id, 1, title, u.value.id);
      insertPull.run(`i${k}`, made.value.defaultBranch, `2026-10-0${k}T10:00:00.000Z`, `oid-${k}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (saved === undefined) delete process.env["FORGE_COMMIT"];
    else process.env["FORGE_COMMIT"] = saved;
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const titles = (b: any) => [...b.live, ...b.onItsWay].map((l: any) => l.title).sort();

  test("answers anyone with the page's shape", async () => {
    const res = await get("?repo=all");
    expect(res.status).toBe(200);
    const b: any = await res.json();
    expect(b.commit).toBe("a".repeat(40));
    expect(typeof b.version).toBe("string");
    const row = [...b.live, ...b.onItsWay][0];
    expect(Object.keys(row).sort()).toEqual(["at", "live", "number", "repo", "title"]);
  });

  test("the repo filter: all, one, and everything when the forge has no repository of its own", async () => {
    expect(titles(await (await get("?repo=all")).json())).toEqual(["Other repo landing", "Public landing"]);
    expect(titles(await (await get("?repo=alice/notes")).json())).toEqual(["Other repo landing"]);
    expect(titles(await (await get("")).json())).toEqual(["Other repo landing", "Public landing"]);
    expect(titles(await (await get("?repo=nobody/nothing")).json())).toEqual(["Other repo landing", "Public landing"]);
    expect(titles(await (await get("?repo=alice/forge")).json())).toEqual(["Public landing"]);
  });

  test("with a repository of its own the default is that repository, on every door", async () => {
    keepLive("alice/forge", [], 0);
    try {
      expect(titles(await (await get("")).json())).toEqual(["Public landing"]);
      expect(titles(await mcp({ shipped: true }, admin))).toEqual(["Public landing"]);
      expect(titles(await (await fetch(`${servers.url}/api/v1/releases?shipped=true`)).json())).toEqual(["Public landing"]);
      expect(titles(await (await get("?repo=all")).json())).toEqual(["Other repo landing", "Public landing"]);
      expect((await get("")).headers.get("cache-control")).toBe("public, max-age=5");
    } finally {
      forgetLive();
    }
  });

  test("a private repo's landing is hidden, even when named, from anonymous and from its owner's token", async () => {
    for (const q of ["?repo=all", "?repo=alice/secret"]) {
      expect(JSON.stringify(await (await get(q)).json())).not.toContain("Private landing");
      expect(JSON.stringify(await (await get(q, admin)).json())).not.toContain("Private landing");
    }
  });

  test("MCP releases returns the same rows", async () => {
    for (const repo of ["all", "alice/notes"]) {
      const viaMcp = await mcp({ shipped: true, repo }, admin);
      expect(viaMcp).toEqual(await (await get(`?repo=${repo}`)).json());
    }
  });

  test("the page links its JSON twin", async () => {
    const html = await (await fetch(`${servers.url}/changelog`)).text();
    expect(html).toContain('rel="alternate" type="application/json"');
    expect(html).toContain('href="/api/v1/changelog?repo=all"');
  });
});
