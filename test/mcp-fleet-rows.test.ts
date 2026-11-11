/** `flow` with `q` (#10132): the rows a fleet line selects, the same ones `/fleet` shows, only those the caller may read. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dir: string;
let app: App;
let servers: Servers;
let aliceTok: string;
let carolTok: string;
let carolCookie: string;
let id = 1;

const call = async (token: string, args: unknown) => {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "flow", arguments: args } }),
  });
  const body: any = await res.json();
  const text: string = body.result.content[0].text;
  return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-mcp-fleet-rows-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, first = false) => {
    const u = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first });
    if (!u.ok) throw new Error(u.error);
    return u.value;
  };
  const alice = await mk("alice", true);
  const carol = await mk("carol");
  aliceTok = createToken(app.db, alice.id, "rw", "rw").token;
  carolTok = createToken(app.db, carol.id, "rw", "rw").token;
  carolCookie = `forge_session=${createSession(app.db, carol.id).token}`;
  for (const [name, visibility] of [["pubrepo", "public"], ["privrepo", "private"]] as const) {
    const r = await createRepo(app, alice, { name, visibility });
    if (!r.ok) throw new Error(String(r.error));
  }
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("MCP and /fleet select the same rows for one line, each for its caller", async () => {
  const line = "repo owner:alice";
  const mcp = await call(carolTok, { q: line });
  expect(mcp.value.kind).toBe("repo");
  expect(mcp.value.columns.length).toBeGreaterThan(0);
  const names = mcp.value.items.map((r: any) => r.repo);
  expect(names).toEqual(["alice/pubrepo"]);
  const page = await (await fetch(`${servers.url}/fleet?${new URLSearchParams({ q: line })}`, { headers: { cookie: carolCookie } })).text();
  expect(page).toContain("alice/pubrepo");
  expect(page).not.toContain("alice/privrepo");

  const admin = await call(aliceTok, { q: line, sort: "-repo" });
  expect(admin.value.items.map((r: any) => r.repo).sort()).toEqual(["alice/privrepo", "alice/pubrepo"]);
});

test("a bad line answers its reason; a bad sort and an empty q are refused", async () => {
  const bad = await call(aliceTok, { q: "run cost:abc" });
  expect(bad.error).toContain("cost wants a number");
  expect((await call(aliceTok, { q: "repo", sort: "nope" })).error).toContain("sort");
  expect((await call(aliceTok, { q: "  " })).error).toContain("q is");
});
