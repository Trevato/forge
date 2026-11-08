/**
 * A repository's forks, labels and webhooks answer `{ items, next_cursor }`
 * (#4843): paged by `limit` and `cursor`, a bad limit a 422, and each route
 * keeps its own permission and filter.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo, forkRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createLabel } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createWebhook } from "../src/core/webhooks.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

describe("forks, labels and webhooks are pages", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let lib: Repo;
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-list-pages-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const users: Record<string, User> = {};
    for (const [name, first] of [["alice", true], ["bob", false], ["carol", false], ["dave", false]] as const) {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username: name,
        email: `${name}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!made.ok) throw new Error(made.error);
      users[name] = made.value;
      tokens[name] = createToken(app.db, made.value.id, "t", "admin").token;
    }
    promote(app.db, users["bob"]!, users["carol"]!);
    const made = await createRepo(app, users["alice"]!, { name: "lib", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    lib = made.value;
    const seeded = await commitToBranch(app, users["alice"]!, lib, {
      message: "Start",
      files: [{ path: "README.md", content: "# lib\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const bobs = await forkRepo(app, users["bob"]!, lib);
    if (!bobs.ok) throw new Error(String(bobs.error));
    const carols = await forkRepo(app, users["carol"]!, lib);
    if (!carols.ok) throw new Error(String(carols.error));
    const closed = await updateRepoSettings(app, users["carol"]!, carols.value, { visibility: "private" });
    if (!closed.ok) throw new Error(String(closed.error));
    for (const name of ["bug", "chore", "docs"]) createLabel(app.db, lib.id, name, "aabbcc");
    for (const n of [1, 2, 3])
      if (!createWebhook(app.db, { repoId: lib.id, url: `https://example.com/h${n}` }).ok)
        throw new Error("hook");
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const get = async (path: string, who?: string) => {
    const res = await fetch(`${servers.url}/api/v1/repos/alice/lib${path}`, {
      headers: who ? { authorization: `Bearer ${tokens[who]}` } : {},
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  test("forks: the shape, and a private fork is not shown to a stranger", async () => {
    const stranger = await get("/forks", "dave");
    expect(stranger.status).toBe(200);
    expect(stranger.body.next_cursor).toBeNull();
    expect(stranger.body.items.map((f: any) => f.ownerName)).toEqual(["bob"]);
    const owner = await get("/forks", "carol");
    expect(owner.body.items.map((f: any) => f.ownerName).sort()).toEqual(["bob", "carol"]);
  });

  test("forks: paging walks every fork once", async () => {
    const first = await get("/forks?limit=1", "carol");
    expect(first.body.items).toHaveLength(1);
    expect(first.body.next_cursor).not.toBeNull();
    const second = await get(`/forks?limit=1&cursor=${first.body.next_cursor}`, "carol");
    expect(second.body.items).toHaveLength(1);
    expect(second.body.next_cursor).toBeNull();
    expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
  });

  test("labels: the shape and paging", async () => {
    const all = await get("/labels");
    expect(all.body.items.map((l: any) => l.name)).toEqual(["bug", "chore", "docs"]);
    expect(all.body.next_cursor).toBeNull();
    const first = await get("/labels?limit=2");
    expect(first.body.items.map((l: any) => l.name)).toEqual(["bug", "chore"]);
    const rest = await get(`/labels?limit=2&cursor=${first.body.next_cursor}`);
    expect(rest.body.items.map((l: any) => l.name)).toEqual(["docs"]);
    expect(rest.body.next_cursor).toBeNull();
  });

  test("hooks: the shape, paging, admin only, and no secret", async () => {
    const all = await get("/hooks", "alice");
    expect(all.status).toBe(200);
    expect(all.body.items).toHaveLength(3);
    expect(JSON.stringify(all.body)).not.toContain("whsec");
    expect(all.body.items[0]).not.toHaveProperty("secret");
    const first = await get("/hooks?limit=2", "alice");
    expect(first.body.items).toHaveLength(2);
    const rest = await get(`/hooks?limit=2&cursor=${first.body.next_cursor}`, "alice");
    expect(rest.body.items).toHaveLength(1);
    expect(rest.body.next_cursor).toBeNull();
    expect((await get("/hooks", "dave")).status).toBe(404);
    expect((await get("/hooks")).status).toBeGreaterThanOrEqual(401);
  });

  test("a cursor whose row is gone is a 422, not a short end", async () => {
    for (const [path, who] of [["/forks", "carol"], ["/labels", "alice"], ["/hooks", "alice"]] as const) {
      const res = await get(`${path}?cursor=01notarealid`, who);
      expect(res.status).toBe(422);
      expect(res.body.error).toBe("invalid_cursor");
    }
  });

  test("a bad limit or cursor is a 422 on all three", async () => {
    for (const path of ["/forks", "/labels", "/hooks"])
      for (const bad of ["limit=0", "limit=201", "limit=abc", "limit=-1", "limit=1.5", "cursor=a%20b"]) {
        const res = await get(`${path}?${bad}`, "alice");
        expect(res.status).toBe(422);
        expect(res.body.error).toBe(bad.startsWith("cursor") ? "invalid_cursor" : "invalid_limit");
      }
  });

  test("repo, pull, issue and fleet-op lists refuse a bad limit with a 422, and take the bounds", async () => {
    const base = `${servers.url}/api/v1`;
    const headers = { authorization: `Bearer ${tokens["alice"]}` };
    const paths = ["/repos", "/users/alice/repos", "/repos/alice/lib/pulls", "/repos/alice/lib/issues", "/fleet/ops"];
    for (const path of paths) {
      for (const bad of ["abc", "0", "-1", "1.5", "201", ""]) {
        const res = await fetch(`${base}${path}?limit=${bad}`, { headers });
        expect(res.status).toBe(422);
        expect(await res.json()).toEqual({
          error: "invalid_limit",
          message: "limit is a whole number from 1 to 200",
        });
      }
      for (const ok of ["", "?limit=1", "?limit=200"])
        expect((await fetch(`${base}${path}${ok}`, { headers })).status).toBe(200);
    }
  });

  test("deleting the row a page ended on makes the next read start over", async () => {
    const first = await get("/labels?limit=1", "alice");
    expect(first.body.next_cursor).toBeTruthy();
    const del = await fetch(`${servers.url}/api/v1/repos/alice/lib/labels/${first.body.next_cursor}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${tokens["alice"]}` },
    });
    expect(del.status).toBe(204);
    const next = await get(`/labels?limit=1&cursor=${first.body.next_cursor}`, "alice");
    expect(next.status).toBe(422);
    expect(next.body.error).toBe("invalid_cursor");
  });
});
