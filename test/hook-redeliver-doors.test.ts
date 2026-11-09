/** Redeliver over the API and MCP `hooks` (#10105): a failed row goes back to pending; others are refused. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createIssue } from "../src/core/issues.ts";
import { setSealed } from "../src/core/sealed.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { createWebhook, recentDeliveries } from "../src/core/webhooks.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir = "";
let app: App, servers: Servers;
let repoId = "", aliceId = "";
let tok = "", other = "", readTok = "", hook = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-hook-redeliver-doors-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, first: boolean) => {
    const u = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@f.dev`, password: "a-good-passphrase", adminIfFirst: first });
    if (!u.ok) throw new Error(String(u.error));
    return u.value;
  };
  const alice = await mk("alice", true);
  const bob = await mk("bob", false);
  const repo = await createRepo(app, alice, { name: "a", visibility: "public" });
  if (!repo.ok) throw new Error("repo");
  const h = createWebhook(app.db, { repoId: repo.value.id, url: "https://a.example/h" });
  if (!h.ok) throw new Error("hook");
  hook = h.value.webhook.id;
  repoId = repo.value.id;
  aliceId = alice.id;
  app.bus.append({ kind: "push", repoId: repo.value.id });
  tok = createToken(app.db, alice.id, "t", "admin").token;
  readTok = createToken(app.db, alice.id, "r", "rw").token;
  other = createToken(app.db, bob.id, "o", "admin").token;
});
afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const fail = () => {
  app.db.run("UPDATE webhook_delivery SET state = 'failed', attempts = 3, last_status = 500, last_error = 'boom'");
  return recentDeliveries(app.db, hook, 1)[0]!.id;
};
const state = () => recentDeliveries(app.db, hook, 1)[0]!;
const api = (id: string, t: string) =>
  fetch(`${servers.url}/api/v1/repos/alice/a/hooks/${hook}/deliveries/${id}/redeliver`, { method: "POST", headers: { authorization: `Bearer ${t}` } });
const mcp = async (args: unknown, t = tok) => {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${t}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "hooks", arguments: args } }),
  });
  const body = (await res.json()) as any;
  if (body.error) return { error: String(body.error.message) };
  const text: string = body.result.content[0].text;
  return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
};

test("the API redelivers a failed row to pending, then refuses it with 409", async () => {
  const id = fail();
  const res = await api(id, tok);
  expect(res.status).toBe(200);
  expect(state()).toMatchObject({ id, state: "pending", attempts: 0 });
  const again = await api(id, tok);
  expect(again.status).toBe(409);
  expect(((await again.json()) as any).message).toContain("failed");
});

test("MCP redelivers a failed row to pending, then refuses it", async () => {
  const id = fail();
  const ok = await mcp({ repo: "alice/a", action: "redeliver", id: hook, delivery: id });
  expect(ok.value).toEqual({ id, state: "pending" });
  expect(state().state).toBe("pending");
  expect((await mcp({ repo: "alice/a", action: "redeliver", id: hook, delivery: id })).error).toContain("failed");
});

test("strangers, short scopes and unknown rows get 404; none of them moves the row", async () => {
  const id = fail();
  expect((await api(id, other)).status).toBe(404);
  expect((await api(id, readTok)).status).toBe(404);
  expect((await api("nope", tok)).status).toBe(404);
  expect(state().state).toBe("failed");
  expect((await mcp({ repo: "alice/a", action: "redeliver", id: hook, delivery: "nope" })).error).toContain("no such");
  expect((await mcp({ repo: "alice/a", action: "redeliver", id: hook, delivery: id }, other)).error).toBeTruthy();
  expect(state().state).toBe("failed");
});

test("a failed delivery of a sealed report stays failed: 409 on the API, conflict on MCP", async () => {
  const issue = createIssue(app.db, { repoId, authorId: aliceId, title: "hole" });
  if (!issue.ok) throw new Error("issue");
  // delivered while open (a sealed event is never queued), sealed afterwards
  app.bus.append({ kind: "issue.opened", repoId, payload: { number: issue.value.number } });
  const id = fail();
  expect(recentDeliveries(app.db, hook, 10).length).toBeGreaterThan(1);
  app.db.run("UPDATE webhook_delivery SET state = 'failed' WHERE id = ?1", [id]);
  setSealed(app.db, issue.value.id, true);
  const res = await api(id, tok);
  expect(res.status).toBe(409);
  expect(((await res.json()) as any).message).toContain("sealed");
  expect(state().state).toBe("failed");
  expect((await mcp({ repo: "alice/a", action: "redeliver", id: hook, delivery: id })).error).toContain("sealed");
  expect(state().state).toBe("failed");
  expect((await mcp({ repo: "alice/a", action: "redeliver", id: hook, delivery: id }, readTok)).error).toBeTruthy();
  expect(state().state).toBe("failed");
});
