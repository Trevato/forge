/**
 * Talk builds an app (#11010): prompt, repository from a template, v1, v2,
 * restore v1, publish: the whole path through the API against a scratch forge.
 * The agent is a stand-in that answers; its code changes are commits the test
 * makes on the branch the conversation names, as the real agent would.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRole } from "../src/actions/roles.ts";
import { setTemplateMark } from "../src/core/app_templates.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { BUILDS_PER_HOUR, UNPUBLISHED_MAX } from "../src/actions/build.ts";
import { chatBuildOf } from "../src/core/chat_build.ts";
import { getRepo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { configureConversation } from "../src/crew/conversation.ts";
import { readerFor } from "../src/git/read.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir: string;
let app: App;
let servers: Servers;
let token: string;
let alice: User;

const headers = (t: string) => ({ "content-type": "application/json", authorization: `Bearer ${t}` });
const call = async (method: string, path: string, body?: unknown, t: string | null = token) => {
  const res = await fetch(`${servers.url}${path}`, { method, headers: t === null ? { "content-type": "application/json" } : headers(t), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const settle = async (conversation: string) => {
  for (let i = 0; i < 200; i++) {
    const res = await fetch(`${servers.url}/api/v1/conversation/turns?conversation=${conversation}`, { headers: headers(token) });
    if (!((await res.json()) as { running: boolean }).running) return;
    await Bun.sleep(25);
  }
  throw new Error("the turn never finished");
};
/** What the agent does in a turn that changes code: one commit on the chat's branch. */
const agentCommits = async (repo: string, branch: string, message: string, content: string) => {
  const [owner, name] = repo.split("/") as [string, string];
  const r = getRepo(app.db, owner, name)!;
  const done = await commitToBranch(app, alice, r, { branch, message, files: [{ path: "page.txt", content }] });
  if (!done.ok) throw new Error(JSON.stringify(done.error));
};
const read = async (repo: string, ref: string, path: string) => {
  const [owner, name] = repo.split("/") as [string, string];
  const o = await readerFor(repoDir(app.reposRoot, owner, name)).object(`${ref}:${path}`);
  return o.ok ? new TextDecoder().decode(o.value.body) : undefined;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-talk-build-"));
  app = createApp({ dataDir: dir, port: 0, host: "forge.test" });
  servers = await serve(app);
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  alice = made.value;
  token = createToken(app.db, alice.id, "personal", "rw").token;
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
IFS= read -r first
printf '%s' "$first" > "${dir}/first.json"
echo '{"type":"system","subtype":"init","session_id":"s1","model":"fake"}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"Built.","total_cost_usd":0.01,"num_turns":1,"session_id":"s1","terminal_reason":"completed","usage":{"input_tokens":1,"output_tokens":1}}'
`,
  );
  chmodSync(bin, 0o755);
  configureConversation(app, { binary: bin, localUrl: servers.url, budgetUsd: 1, timeoutMs: 30_000, signal: new AbortController().signal });
});
afterAll(async () => {
  await servers.stop();
  await rm(dir, { recursive: true, force: true });
});

test("prompt, repo, v1, v2, restore v1, publish", async () => {
  // A template to build from.
  const tpl = await createRepo(app, alice, { name: "kit", visibility: "public", description: "" });
  if (!tpl.ok) throw new Error(tpl.error);
  const seeded = await commitToBranch(app, alice, tpl.value, { message: "t", files: [{ path: "README.md", content: "# kit\n" }] });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));

  setTemplateMark(app.db, tpl.value, true, alice.id);

  // The prompt makes the repository from the template and starts the chat in it.
  const started = await call("POST", "/api/v1/builds", { prompt: "a tip calculator for friends", template: "alice/kit" });
  expect(started.status).toBe(201);
  const { conversation, repo, branch } = started.body as { conversation: string; repo: string; branch: string };
  expect(repo).toBe("alice/tip-calculator");
  expect(branch).toBe(`talk-${conversation}`);
  expect(await read(repo, "refs/heads/main", "README.md")).toBe("# kit\n");
  expect(chatBuildOf(app.db, conversation)?.repoId).toBe(getRepo(app.db, "alice", "tip-calculator")!.id);
  await settle(conversation);

  // The agent is told where to work, with the person's words after it.
  const first = readFileSync(join(dir, "first.json"), "utf8");
  expect(first).toContain(`on the branch ${branch}`);
  expect(first).toContain("a tip calculator for friends");

  // No code changed yet: no version.
  expect((await call("GET", `/api/v1/conversations/${conversation}/build`)).body["versions"]).toEqual([]);

  // v1 and v2.
  await agentCommits(repo, branch, "Add the tip form", "one\n");
  await agentCommits(repo, branch, "Round tips up", "two\n");
  const two = (await call("GET", `/api/v1/conversations/${conversation}/build`)).body;
  expect(two["versions"].map((v: { number: number; subject: string }) => `v${v.number} ${v.subject}`)).toEqual(["v1 Add the tip form", "v2 Round tips up"]);
  // A read changes nothing: the pull that previews the branch is not opened by looking.
  expect(chatBuildOf(app.db, conversation)?.pullNumber).toBeNull();

  // A version's diff is what that turn changed.
  const diff = (await call("GET", `/api/v1/conversations/${conversation}/build/versions/2/diff`)).body;
  expect(JSON.stringify(diff)).toContain("two");
  expect((await call("GET", `/api/v1/conversations/${conversation}/build/versions/9/diff`)).status).toBe(404);

  // Restore v1 makes v3 holding v1's files; v1 and v2 stay.
  const restored = await call("POST", `/api/v1/conversations/${conversation}/build/restore`, { version: 1 });
  expect(restored.status).toBe(201);
  expect(await read(repo, `refs/heads/${branch}`, "page.txt")).toBe("one\n");
  // Restore is a write by a person who may write: it gives the branch its pull.
  expect(chatBuildOf(app.db, conversation)?.pullNumber).toBeGreaterThan(0);
  const three = (await call("GET", `/api/v1/conversations/${conversation}/build`)).body;
  expect(three["versions"].map((v: { subject: string }) => v.subject)).toEqual(["Add the tip form", "Round tips up", "Restore v1"]);
  expect((await call("POST", `/api/v1/conversations/${conversation}/build/restore`, { version: 7 })).status).toBe(404);

  // Main has not moved until the person publishes.
  expect(await read(repo, "refs/heads/main", "page.txt")).toBeUndefined();
  const published = await call("POST", `/api/v1/conversations/${conversation}/build/publish`);
  expect(published.status).toBe(200);
  expect(await read(repo, "refs/heads/main", "page.txt")).toBe("one\n");
  expect((await call("GET", `/api/v1/conversations/${conversation}/build`)).body["published"]).toBe(true);
});

test("a build is its owner's alone, and every change is refused without sign-in or a same-origin browser", async () => {
  const mine = await call("POST", "/api/v1/builds", { prompt: "a private notebook" });
  const id = (mine.body as { conversation: string }).conversation;
  expect((await call("GET", `/api/v1/conversations/${id}/build`, undefined, null)).status).toBe(401);
  expect((await call("POST", "/api/v1/builds", { prompt: "x" }, null)).status).toBe(401);
  const other = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
  if (!other.ok) throw new Error(other.error);
  const bob = createToken(app.db, other.value.id, "personal", "rw").token;
  expect((await call("GET", `/api/v1/conversations/${id}/build`, undefined, bob)).status).toBe(404);
  expect((await call("POST", `/api/v1/conversations/${id}/build/publish`, undefined, bob)).status).toBe(404);
  expect((await call("POST", `/api/v1/conversations/${id}/build/publish`)).status).toBe(409);
  expect((await call("POST", "/api/v1/builds", { prompt: "" })).status).toBe(422);
  expect((await call("POST", "/api/v1/builds", { prompt: "x", template: "../a" })).status).toBe(422);
  const cross = await fetch(`${servers.url}/api/v1/builds`, { method: "POST", headers: { ...headers(token), origin: "https://evil.test" }, body: JSON.stringify({ prompt: "a thing" }) });
  expect(cross.status).toBe(403);
});

test("the page: one box on an empty Talk, then the versions, Restore and Publish as plain forms", async () => {
  const { createSession } = await import("../src/core/sessions.ts");
  const cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  const get = (path: string) => fetch(`${servers.url}${path}`, { redirect: "manual", headers: { cookie } });
  const post = (path: string, form: Record<string, string>) =>
    fetch(`${servers.url}${path}`, { method: "POST", redirect: "manual", headers: { origin: servers.url, cookie }, body: new URLSearchParams(form) });

  const empty = await (await get("/talk/new-never")).status;
  expect(empty).toBe(404);
  const fresh = await call("POST", "/api/v1/conversations", {});
  const home = await (await get(`/talk/${fresh.body["conversation"].id}`)).text();
  expect(home).toContain("What do you want to build?");
  expect(home).toContain('action="/talk/build"');

  const sent = await post("/talk/build", { prompt: "a recipe box" });
  expect(sent.status).toBe(303);
  const to = sent.headers.get("location")!;
  expect(to).toMatch(/^\/talk\/[0-9a-z]+$/);
  const id = to.slice("/talk/".length);
  await settle(id);
  const none = await (await get(to)).text();
  expect(none).toContain("alice/recipe-box");
  expect(none).not.toContain("What do you want to build?");
  expect(none).not.toContain("/build/publish");

  const { branch, repo } = (await call("GET", `/api/v1/conversations/${id}/build`)).body as { branch: string; repo: string };
  await agentCommits(repo, branch, "Add recipe list", "one\n");
  const one = await (await get(`${to}?v=1`)).text();
  expect(one).toContain("v1");
  expect(one).toContain("page.txt");
  expect(one).toContain(`action="${to}/build/restore"`);
  expect(one).toContain(`action="${to}/build/publish"`);

  expect((await post(`${to}/build/restore`, { version: "1" })).status).toBe(303);
  expect((await call("GET", `/api/v1/conversations/${id}/build`)).body["versions"].length).toBe(2);
  expect((await post(`${to}/build/publish`, {})).status).toBe(303);
  const done = await (await get(to)).text();
  expect(done).toContain("published");
  // Another person's build is not found, and a cross-origin form is refused.
  expect((await post("/talk/nope/build/publish", {})).status).toBe(404);
  const cross = await fetch(`${servers.url}${to}/build/publish`, { method: "POST", redirect: "manual", headers: { origin: "https://evil.test", cookie }, body: new URLSearchParams({}) });
  expect(cross.status).toBe(403);
});

const makeUser = async (username: string) => {
  const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase" });
  if (!made.ok) throw new Error(made.error);
  setRole(app, alice, username, "member");
  return { user: made.value, token: createToken(app.db, made.value.id, "personal", "rw").token };
};

test("a read never writes: looking at a build with a version, even on a read-only token, opens no pull", async () => {
  const { user, token: rw } = await makeUser("reader");
  const ro = createToken(app.db, user.id, "personal", "ro").token;
  const started = await call("POST", "/api/v1/builds", { prompt: "a reading list" }, rw);
  const { conversation, repo, branch } = started.body as { conversation: string; repo: string; branch: string };
  const [owner, name] = repo.split("/") as [string, string];
  const done = await commitToBranch(app, user, getRepo(app.db, owner, name)!, { branch, message: "Add list", files: [{ path: "page.txt", content: "x\n" }] });
  if (!done.ok) throw new Error(JSON.stringify(done.error));
  const before = JSON.stringify(chatBuildOf(app.db, conversation));
  for (const t of [ro, rw]) {
    const state = await call("GET", `/api/v1/conversations/${conversation}/build`, undefined, t);
    expect(state.body["versions"].length).toBe(1);
    expect((await call("GET", `/api/v1/conversations/${conversation}/build/versions/1/diff`, undefined, t)).status).toBe(200);
  }
  expect(JSON.stringify(chatBuildOf(app.db, conversation))).toBe(before);
  expect(chatBuildOf(app.db, conversation)?.pullNumber).toBeNull();
  // The read-only token cannot Restore or Publish either.
  expect((await call("POST", `/api/v1/conversations/${conversation}/build/publish`, undefined, ro)).status).toBe(403);
});

test("a template that is not on offer to the person is refused, so the API cannot read a private repository as one", async () => {
  const owner = await makeUser("vault");
  const secret = await createRepo(app, owner.user, { name: "secret-kit", visibility: "private", description: "" });
  if (!secret.ok) throw new Error(secret.error);
  setTemplateMark(app.db, secret.value, true, owner.user.id);
  const open = await createRepo(app, owner.user, { name: "plain-kit", visibility: "public", description: "" });
  if (!open.ok) throw new Error(open.error);
  const asker = await makeUser("asker");
  const private_ = await call("POST", "/api/v1/builds", { prompt: "a copy", template: "vault/secret-kit" }, asker.token);
  expect(private_.status).toBe(422);
  expect(private_.body["error"]).toBe("bad_template");
  // A readable repository nobody marked as a template is not on offer either.
  expect((await call("POST", "/api/v1/builds", { prompt: "a copy", template: "vault/plain-kit" }, asker.token)).status).toBe(422);
  expect(getRepo(app.db, "asker", "copy")).toBeUndefined();
});

test("builds are limited per person, and a refused start leaves no repository or conversation behind", async () => {
  const { listConversations } = await import("../src/core/conversations.ts");
  const person = await makeUser("hasty");
  const held = () => listConversations(app.db, person.user.id).length;
  // A prompt with no name to derive is refused, and takes back what it made.
  expect((await call("POST", "/api/v1/builds", { prompt: "!!!" }, person.token)).status).toBe(422);
  expect(held()).toBe(0);
  for (let i = 0; i < BUILDS_PER_HOUR; i++) expect((await call("POST", "/api/v1/builds", { prompt: `quick idea number ${"x".repeat(i + 1)}` }, person.token)).status).toBe(201);
  const refused = await call("POST", "/api/v1/builds", { prompt: "one idea too many" }, person.token);
  expect(refused.status).toBe(429);
  expect(held()).toBe(BUILDS_PER_HOUR);
  // Another person's budget is their own.
  const other = await makeUser("calm");
  expect((await call("POST", "/api/v1/builds", { prompt: "a calm idea" }, other.token)).status).toBe(201);
});

test("a person may hold only so many builds that are not published", async () => {
  const { createConversation } = await import("../src/core/conversations.ts");
  const { startChatBuild } = await import("../src/core/chat_build.ts");
  const person = await makeUser("hoarder");
  const anyRepo = getRepo(app.db, "alice", "kit")!;
  for (let i = 0; i < UNPUBLISHED_MAX; i++) {
    const c = createConversation(app.db, person.user.id);
    if (!c.ok) throw new Error("conversation");
    startChatBuild(app.db, c.value.id, anyRepo.id);
  }
  const refused = await call("POST", "/api/v1/builds", { prompt: "an eleventh idea" }, person.token);
  expect(refused.status).toBe(429);
  expect(refused.body["error"]).toBe("too_many_builds");
});
