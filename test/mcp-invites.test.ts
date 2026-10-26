/**
 * The `invites` tool is the admin invites API over MCP: the same actions, so
 * the same rules. A listing never carries a link or a token.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { setSignup } from "../src/settings/signup.ts";
import { setLimit } from "../src/settings/limits.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { promote } from "./helpers/members.ts";
import { createUser } from "../src/core/users.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir: string;
let app: App;
let servers: Servers;
let admin = "";
let ro = "";
let rw = "";
let bob = "";
let id = 1;

const tool = async (token: string, name: string, args: unknown = {}) => {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = (await res.json()) as any;
  const text: string = body.result.content[0].text;
  return { text, error: body.result.isError === true, value: body.result.isError ? undefined : JSON.parse(text) };
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-mcp-invites-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const a = await seedAdmin(app, { username: "olive", email: "o@f.dev", password: "owner-passphrase" });
  if (!a.ok) throw new Error(a.error);
  setSignup(app.db, "invite", a.value.id);
  setLimit(app.db, "signup.per_source", 1000, a.value.id);
  const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "b@f.dev", password: "a-good-passphrase" });
  if (!b.ok) throw new Error(b.error);
  promote(app.db, b.value);
  admin = createToken(app.db, a.value.id, "admin", "admin").token;
  ro = createToken(app.db, a.value.id, "ro", "ro").token;
  rw = createToken(app.db, a.value.id, "rw", "rw").token;
  bob = createToken(app.db, b.value.id, "bob", "admin").token;
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const signup = (username: string, invite: string) =>
  fetch(`${servers.url}/api/v1/users`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, email: `${username}@f.dev`, password: "an-invited-passphrase", invite }),
  });

test("an admin mints, lists and revokes; a revoked link signs no one up", async () => {
  const kept = (await tool(admin, "mint_invite", { days: 3 })).value;
  const gone = (await tool(admin, "mint_invite")).value;
  const goneToken = gone.link.split("invite=")[1];

  const listed = await tool(admin, "invites", { action: "list" });
  const ids = listed.value.items.map((i: { id: string }) => i.id);
  expect(ids).toContain(kept.id);
  expect(ids).toContain(gone.id);
  expect(listed.text).not.toContain("link");
  expect(listed.text).not.toContain(goneToken);
  expect(listed.text).not.toContain(kept.link.split("invite=")[1]);

  const done = await tool(admin, "invites", { action: "revoke", id: gone.id });
  expect(done.value.state).toBe("revoked");
  expect((await tool(admin, "invites", { action: "revoke", id: gone.id })).error).toBe(true);
  expect((await tool(admin, "invites", { action: "revoke" })).text).toContain("invalid");
  expect((await tool(admin, "invites", { action: "nope" })).text).toContain("invalid");

  expect((await signup("late", goneToken)).status).toBeGreaterThanOrEqual(400);
  expect((await signup("early", kept.link.split("invite=")[1])).status).toBeLessThan(300);
});

test("a non-admin and a lesser token are refused", async () => {
  expect((await tool(bob, "invites", { action: "list" })).text).toContain("forbidden");
  for (const token of [ro, rw]) {
    for (const args of [{ action: "list" }, { action: "revoke", id: "x" }]) {
      const res = await tool(token, "invites", args);
      expect(res.error).toBe(true);
      expect(res.text).toContain("forbidden");
    }
  }
  expect((await tool(ro, "invites", { action: "list" })).text).toContain("may read, not act");
  expect((await tool(rw, "invites", { action: "list" })).text).toContain("need an admin token");
});
