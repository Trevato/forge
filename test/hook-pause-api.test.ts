/** POST …/hooks/:id/pause and /resume, and MCP `hooks` pause and resume (#10104). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createWebhook, getWebhook, recentDeliveries } from "../src/core/webhooks.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let repoId = "";
let hook = "";
let adminTok = "";
let otherTok = "";
let aliceId = "";
let aliceUser: User;
const cells = process.env["FORGE_CELLS"];

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-hook-pause-api-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, first: boolean) => {
    const made = await createUser(app.db, {
      origin: "seed", trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", adminIfFirst: first,
    });
    if (!made.ok) throw new Error(String(made.error));
    return made.value;
  };
  const alice = await mk("alice", true);
  const bob = await mk("bob", false);
  aliceId = alice.id;
  aliceUser = alice;
  const repo = await createRepo(app, alice, { name: "a", visibility: "public" });
  if (!repo.ok) throw new Error("repo");
  repoId = repo.value.id;
  const made = createWebhook(app.db, { repoId, url: "https://a.example/h" });
  if (!made.ok) throw new Error("hook");
  hook = made.value.webhook.id;
  adminTok = createToken(app.db, alice.id, "t", "admin").token;
  otherTok = createToken(app.db, bob.id, "o", "admin").token;
});
afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

const api = (verb: string, id: string, tok: string) =>
  fetch(`${servers.url}/api/v1/repos/alice/a/hooks/${id}/${verb}`, { method: "POST", headers: { authorization: `Bearer ${tok}` } });
const mcp = async (args: unknown, tok = adminTok) => {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tok}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "hooks", arguments: args } }),
  });
  const body = (await res.json()) as any;
  if (body.error) return { error: body.error.message as string };
  const text: string = body.result.content[0].text;
  return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
};
const emit = () => app.bus.append({ kind: "tag", repoId, actorId: null, payload: {} } as any);
const queued = () => recentDeliveries(app.db, hook).length;
const active = () => !!getWebhook(app.db, repoId, hook)!.active;

test("the API pauses: nothing new is queued; resume queues again", async () => {
  emit();
  expect(queued()).toBe(1);
  const paused = await api("pause", hook, adminTok);
  expect(paused.status).toBe(200);
  expect(await paused.json()).toEqual({ id: hook, active: false });
  expect(active()).toBe(false);
  emit();
  expect(queued()).toBe(1);
  const resumed = await api("resume", hook, adminTok);
  expect(await resumed.json()).toEqual({ id: hook, active: true });
  // Resume queues one delivery on its own: the `webhook.resumed` event is
  // appended after the hook is active again, so a hook watching `*` gets it.
  expect(recentDeliveries(app.db, hook).map((d) => d.kind)).toContain("webhook.resumed");
  const before = queued();
  emit();
  expect(queued()).toBe(before + 1);
});

test("MCP pauses and resumes with the same effect", async () => {
  expect((await mcp({ repo: "alice/a", action: "pause", id: hook })).value).toEqual({ id: hook, active: false });
  expect(active()).toBe(false);
  const before = queued();
  emit();
  expect(queued()).toBe(before);
  expect((await mcp({ repo: "alice/a", action: "resume", id: hook })).value).toEqual({ id: hook, active: true });
  const resumedAt = queued();
  emit();
  expect(queued()).toBe(resumedAt + 1);
});

test("a token short of admin scope gets 404 and changes nothing, even the owner's", async () => {
  const writeTok = createToken(app.db, aliceId, "w", "rw").token;
  const readTok = createToken(app.db, aliceId, "r", "ro").token;
  for (const tok of [writeTok, readTok]) expect((await api("pause", hook, tok)).status).toBe(404);
  expect(active()).toBe(true);
  expect((await mcp({ repo: "alice/a", action: "pause", id: hook }, writeTok)).error).toBeTruthy();
  expect(active()).toBe(true);
  await api("pause", hook, adminTok);
  expect((await api("resume", hook, writeTok)).status).toBe(404);
  expect(active()).toBe(false);
  await api("resume", hook, adminTok);
});

test("another repository's hook id is 404 on the API and MCP and stays active", async () => {
  const theirs = await createRepo(app, aliceUser, { name: "b", visibility: "public" });
  if (!theirs.ok) throw new Error("repo b " + JSON.stringify(theirs.error));
  const made = createWebhook(app.db, { repoId: theirs.value.id, url: "https://b.example/h" });
  if (!made.ok) throw new Error("hook b");
  const foreign = made.value.webhook.id;
  expect((await api("pause", foreign, adminTok)).status).toBe(404);
  expect((await mcp({ repo: "alice/a", action: "pause", id: foreign })).error).toContain("no such webhook");
  expect(!!getWebhook(app.db, theirs.value.id, foreign)!.active).toBe(true);
});

test("a non-admin, a missing hook and no credentials get 404 / 401, and nothing changes", async () => {
  expect((await api("pause", hook, otherTok)).status).toBe(404);
  expect((await api("pause", "nope", adminTok)).status).toBe(404);
  expect((await fetch(`${servers.url}/api/v1/repos/alice/a/hooks/${hook}/pause`, { method: "POST" })).status).toBe(401);
  expect((await mcp({ repo: "alice/a", action: "pause", id: "nope" })).error).toContain("no such webhook");
  expect((await mcp({ repo: "alice/a", action: "pause", id: hook }, otherTok)).error).toBeTruthy();
  expect(active()).toBe(true);
});
