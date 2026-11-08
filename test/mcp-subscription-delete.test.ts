/** MCP `subscription_delete`: the Subscriptions page's removal, from a harness. */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createRun } from "../src/core/runs.ts";
import { addSubscription, getSubscription, listGrants, setGrants } from "../src/core/subscriptions.ts";
import { SUBSCRIPTION_WORDS } from "../src/core/subscriptions_words.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASS = "a-long-subscription-passphrase";
const KEY = "sk-ant-api03-work-key-for-the-test";

let dataDir = "";
let app: App;
let servers: Servers;

const mcp = async (token: string, args: unknown) => {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "subscription_delete", arguments: args } }),
  });
  const body = (await res.json()) as any;
  // A non-admin's tools/list lacks the tool, so the call is a JSON-RPC error, not a result.
  if (body.error) return { error: true, text: body.error.message as string };
  return { error: body.result.isError === true, text: body.result.content[0].text as string };
};

const pool = (name: string) => {
  const added = addSubscription(app.db, dataDir, { name, token: KEY });
  if (!added.ok) throw new Error(added.error);
  return added.value;
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-subdel-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  for (const [username, isAdmin] of [["alice", true], ["bob", false]] as const) {
    const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@x.test`, password: PASS, isAdmin });
    if (!made.ok) throw new Error(username);
  }
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const adminToken = () => createToken(app.db, getUserByName(app.db, "alice")!.id, "t", "admin").token;

test("an admin removes one, and it is gone from the page with its grants", async () => {
  const sub = pool("gone");
  setGrants(app.db, "scope-1", "*", [sub.id]);
  expect(listGrants(app.db, "scope-1")).toHaveLength(1);
  const r = await mcp(adminToken(), { id: sub.id });
  expect(r.error).toBe(false);
  expect(JSON.parse(r.text)).toEqual({
    id: sub.id,
    says: SUBSCRIPTION_WORDS.removed,
  });
  expect(getSubscription(app.db, sub.id)).toBeUndefined();
  expect(listGrants(app.db, "scope-1")).toHaveLength(0);
});

test("a run it paid for still names it", async () => {
  const sub = pool("paid");
  const alice = getUserByName(app.db, "alice")!;
  const made = await createRepo(app, alice, { name: "hello", visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  const run = createRun(app.db, { repoId: made.value.id, kind: "agent", reason: "assigned" });
  app.db.query("UPDATE run SET subscription_id = ?1 WHERE id = ?2").run(sub.id, run.id);
  expect((await mcp(adminToken(), { id: sub.id })).error).toBe(false);
  expect(app.db.query("SELECT subscription_id FROM run WHERE id = ?1").get(run.id)).toEqual({ subscription_id: sub.id });
});

test("an unknown id is refused", async () => {
  const r = await mcp(adminToken(), { id: "nope" });
  expect(r.error).toBe(true);
  expect(r.text).toContain("No such subscription.");
});

test("a non-admin never sees the tool: the call is an unknown tool, and the subscription stays", async () => {
  const sub = pool("kept");
  const bob = createToken(app.db, getUserByName(app.db, "bob")!.id, "t", "admin").token;
  const r = await mcp(bob, { id: sub.id });
  expect(r.error).toBe(true);
  expect(getSubscription(app.db, sub.id)).toBeDefined();
});

test("an admin's everyday rw token is refused: it needs an admin token, and the subscription stays", async () => {
  const sub = pool("rw-kept");
  const rw = createToken(app.db, getUserByName(app.db, "alice")!.id, "t", "rw").token;
  const r = await mcp(rw, { id: sub.id });
  expect(r.error).toBe(true);
  expect(r.text).toContain("no tool named subscription_delete");
  expect(getSubscription(app.db, sub.id)).toBeDefined();
});
