/** GET /api/v1/feed's first page carries the "Since you were here" digest, as MCP `feed` does (#9104). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { lastVisit } from "../src/core/home_visit.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

let dir: string;
let app: App;
let servers: Servers;
let alice: User;
let token: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-feed-digest-http-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const r = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@forge.test", password: "a-good-passphrase", adminIfFirst: true });
  if (!r.ok) throw new Error(r.error);
  alice = r.value;
  promote(app.db, alice);
  token = createToken(app.db, alice.id, "digest", "ro").token;
  const g = await createRepo(app, alice, { name: "garden", visibility: "public" });
  if (!g.ok) throw new Error("repo");
  for (const v of ["1.2.3", "1.2.4"]) app.bus.append({ kind: "app.serving", repoId: g.value.id, payload: { app: "garden", env: "production", commitOid: "a".repeat(40), version: v } });
  app.db.query("INSERT INTO issue (id, repo_id, number, kind, title, author_id) VALUES ('d1', ?1, 1, 'pull', 't', ?2)").run(g.value.id, alice.id);
  app.db.query("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at) VALUES ('d1', 'main', 'h', 'a', 'b', ?1)").run(new Date(Date.now() - 600_000).toISOString());
});

afterAll(async () => {
  servers.stop?.();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const http = (query = "", etag?: string) =>
  fetch(`${servers.url}/api/v1/feed${query}`, { headers: { authorization: `Bearer ${token}`, ...(etag ? { "if-none-match": etag } : {}) } });

const mcp = async (args: object): Promise<any> => {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "feed", arguments: args } }),
  });
  return JSON.parse(((await res.json()) as any).result.content[0].text);
};

test("the first page carries the digest MCP carries; a page with a cursor carries none", async () => {
  const first = await http("?limit=1");
  const page: any = await first.json();
  expect(page.digest.lines.length).toBeGreaterThan(0);
  expect(first.headers.get("server-timing")).toContain("digest");
  expect(page.digest).toEqual((await mcp({ limit: 1 })).digest);
  expect(page.next_cursor).toBeTruthy();
  const next: any = await (await http(`?limit=1&cursor=${encodeURIComponent(page.next_cursor)}`)).json();
  expect("digest" in next).toBe(false);
  expect(lastVisit(app.db, alice.id)).toBeUndefined();
});

test("the ETag moves with the last visit, so a 304 never hides a new digest", async () => {
  const res = await http();
  await res.arrayBuffer();
  const tag = res.headers.get("etag")!;
  expect((await http("", tag)).status).toBe(304);
  app.db.query("INSERT INTO home_visit (user_id, at) VALUES (?1, ?2) ON CONFLICT(user_id) DO UPDATE SET at = excluded.at").run(alice.id, Date.now() - 3_600_000);
  const after = await http("", tag);
  expect(after.status).toBe(200);
  expect(after.headers.get("etag")).not.toBe(tag);
});
