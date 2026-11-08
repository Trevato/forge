/**
 * Many conversations (#8814): /talk lists them with New, each opens at
 * /talk/<id>, rename and archive are plain forms, the API and the MCP reach
 * the same calls, another person's id is a 404, and the migration that
 * lifted one-per-person keeps the turns it found.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { appendTurn, archiveConversation, CONVERSATIONS_MAX, createConversation, listConversations, listTurns, newConversation, openConversation, renameConversation } from "../src/core/conversations.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { migrations } from "../src/core/schema.ts";
import { createUser, type User } from "../src/core/users.ts";
import { migrationFiles } from "../src/core/schema.ts";
import { openDb } from "../src/kernel/db.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { tool as sayTool } from "../src/http/mcp/tools/say.ts";
import { promote } from "./helpers/members.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir: string;
let app: App;
let servers: Servers;
let alice: User;
let bob: User;

const cookie = (u: User) => `forge_session=${createSession(app.db, u.id).token}`;
const get = (path: string, u?: User) =>
  fetch(`${servers.url}${path}`, { redirect: "manual", headers: u ? { cookie: cookie(u) } : {} });
const post = (path: string, u: User, form: Record<string, string>) =>
  fetch(`${servers.url}${path}`, { method: "POST", redirect: "manual", headers: { origin: servers.url, cookie: cookie(u) }, body: new URLSearchParams(form) });
const api = (method: string, path: string, u: User, body?: unknown) =>
  fetch(`${servers.url}${path}`, {
    method,
    redirect: "manual",
    headers: { origin: servers.url, cookie: cookie(u), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-talk-many-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, first = false) => {
    const u = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first });
    if (!u.ok) throw new Error(u.error);
    promote(app.db, u.value);
    return u.value;
  };
  alice = await mk("alice", true);
  bob = await mk("bob");
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the page", () => {
  test("New makes a conversation at its own URL that survives a reload, and the list shows it", async () => {
    const made = await post("/talk/new", alice, {});
    expect(made.status).toBe(303);
    const url = made.headers.get("location")!;
    expect(url).toMatch(/^\/talk\/[0-9a-z]+$/);
    const first = await (await get(url, alice)).text();
    const again = await get(url, alice);
    expect(again.status).toBe(200);
    expect(first).toContain(`data-c="${url.slice(6)}"`);
    expect(await again.text()).toContain(`href="${url}"`);
    expect((await get("/talk", alice)).status).toBe(200);
  });

  test("rename shows the title in the list; archive moves it behind the filter; restore brings it back", async () => {
    const c = newConversation(app.db, alice.id);
    const renamed = await post(`/talk/${c.id}/rename`, alice, { title: "Weekly <plan>" });
    expect(renamed.status).toBe(303);
    const page = await (await get(`/talk/${c.id}`, alice)).text();
    expect(page).toContain("Weekly &lt;plan&gt;");
    expect(page).not.toContain("Weekly <plan>");
    await post(`/talk/${c.id}/archive`, alice, { archived: "1" });
    const list = await (await get("/talk", alice)).text();
    expect(list).not.toContain(`href="/talk/${c.id}"`);
    expect(list).toContain("Archived (");
    expect(await (await get("/talk?archived=1", alice)).text()).toContain(`href="/talk/${c.id}"`);
    expect(await (await get(`/talk/${c.id}`, alice)).text()).toContain("sending here keeps it archived");
    await post(`/talk/${c.id}/archive`, alice, { archived: "0" });
    expect(await (await get("/talk", alice)).text()).toContain(`href="/talk/${c.id}"`);
    expect(await (await get(`/talk/${c.id}`, alice)).text()).not.toContain("sending here keeps it archived");
  });

  test("another person's id answers 404 for view, send, rename, archive and stream", async () => {
    const mine = newConversation(app.db, alice.id);
    expect((await get(`/talk/${mine.id}`, bob)).status).toBe(404);
    expect((await post(`/talk/${mine.id}`, bob, { text: "hi" })).status).toBe(404);
    expect((await post(`/talk/${mine.id}/rename`, bob, { title: "mine now" })).status).toBe(404);
    expect((await post(`/talk/${mine.id}/archive`, bob, { archived: "1" })).status).toBe(404);
    expect((await get(`/talk/stream?c=${mine.id}`, bob)).status).toBe(404);
    expect((await get("/talk/nope!", bob)).status).toBe(404);
    expect(listConversations(app.db, alice.id).find((c) => c.id === mine.id)?.title).toBe("");
  });

  test("signed out is sent to sign in", async () => {
    expect((await get("/talk/abc")).status).toBe(303);
    expect((await post("/talk/new", alice, {})).status).toBe(303);
  });
});

describe("the API", () => {
  test("list, new, rename, archive; another person's id is 404", async () => {
    const made = await api("POST", "/api/v1/conversations", alice, { title: "From the API" });
    expect(made.status).toBe(201);
    const { conversation } = (await made.json()) as { conversation: { id: string; title: string } };
    expect(conversation.title).toBe("From the API");
    const listed = (await (await api("GET", "/api/v1/conversations", alice)).json()) as { conversations: { id: string }[] };
    expect(listed.conversations.some((c) => c.id === conversation.id)).toBe(true);
    const patched = await api("PATCH", `/api/v1/conversations/${conversation.id}`, alice, { title: "Renamed", archived: true });
    expect(patched.status).toBe(200);
    const after = (await (await api("GET", "/api/v1/conversations?archived=1", alice)).json()) as { conversations: { id: string; title: string }[] };
    expect(after.conversations.find((c) => c.id === conversation.id)?.title).toBe("Renamed");
    expect((await api("PATCH", `/api/v1/conversations/${conversation.id}`, bob, { title: "x" })).status).toBe(404);
    expect((await api("PATCH", `/api/v1/conversations/${conversation.id}`, alice, { title: "x".repeat(81) })).status).toBe(422);
    expect((await api("GET", `/api/v1/conversation/turns?conversation=${conversation.id}`, bob)).status).toBe(404);
    expect((await api("GET", `/api/v1/conversation/turns?conversation=${conversation.id}`, alice)).status).toBe(200);
    expect((await api("POST", "/api/v1/conversation/messages", bob, { text: "hi", conversation: conversation.id })).status).toBe(404);
  });
});

describe("the MCP", () => {
  test("say with an action lists, starts, renames and archives, and refuses another person's id", async () => {
    const ctx = { app, auth: { user: alice, via: "session" } } as never;
    const run = async (u: User, args: Record<string, unknown>) => {
      const answer = (await sayTool.run(ctx, u, args)) as { ok: boolean; value?: any; error?: string };
      return answer.ok ? answer.value : { error: answer.error };
    };
    const made = await run(alice, { action: "new", title: "By agent" });
    expect(made.conversation).toMatch(/^[0-9a-z]+$/);
    expect((await run(alice, { action: "list" })).conversations.some((c: { id: string }) => c.id === made.conversation)).toBe(true);
    expect((await run(alice, { action: "rename", conversation: made.conversation, title: "Better" })).says).toBe("Renamed.");
    expect((await run(alice, { action: "archive", conversation: made.conversation })).says).toBe("Archived.");
    expect((await run(bob, { action: "archive", conversation: made.conversation })).error).toBe("not_found");
    expect((await run(alice, { action: "list" })).conversations.some((c: { id: string }) => c.id === made.conversation)).toBe(false);
    expect((await run(alice, { action: "list", archived: true })).conversations.some((c: { id: string }) => c.id === made.conversation)).toBe(true);
    expect((await run(alice, {})).error).toBe("invalid_text");
  });
});

describe("the migration", () => {
  test("a person's one conversation, its turns and runs come through the table rebuild", () => {
    const db = openDb(join(dir, "before.db"), migrations.slice(0, -1));
    db.query("INSERT INTO user (id, username, email, password_hash) VALUES ('u1','u1','u1@x','x')").run();
    db.query("INSERT INTO conversation (id, user_id, claude_session_id, created_at, updated_at) VALUES ('c1','u1','s','t','t')").run();
    for (const n of [1, 2, 3]) appendTurn(db, "u1", "c1", { role: "person", text: `t${n}` });
    db.query("INSERT INTO conversation_run (id, conversation_id, user_id, prompt, started_at) VALUES ('r1','c1','u1','p','t')").run();
    db.close();
    const after = openDb(join(dir, "before.db"), migrations);
    expect(openConversation(after, "u1").id).toBe("c1");
    const turns = listTurns(after, "u1", "c1");
    expect(turns.ok && turns.value.map((t) => t.text)).toEqual(["t1", "t2", "t3"]);
    expect(after.query("SELECT COUNT(*) AS n FROM conversation_run").get()).toEqual({ n: 1 });
    expect(newConversation(after, "u1").id).not.toBe("c1");
    after.close();
  });
});

describe("the migration keeps attachments", () => {
  test("a file row, hung off a conversation and a turn, survives the table rebuild", () => {
    const at = migrationFiles.findIndex((m) => m.name === "20261103120000-conversations-many");
    expect(at).toBeGreaterThan(0);
    const path = join(dir, "files.db");
    const db = openDb(path, migrationFiles.slice(0, at).map((m) => m.sql));
    db.query("INSERT INTO user (id, username, email, password_hash) VALUES ('u1','u1','u1@x','x')").run();
    db.query("INSERT INTO conversation (id, user_id, claude_session_id, created_at, updated_at) VALUES ('c1','u1','s','t','t')").run();
    const turn = appendTurn(db, "u1", "c1", { role: "person", text: "see" });
    if (!turn.ok) throw new Error("no turn");
    db.query("INSERT INTO conversation_file (id, conversation_id, user_id, turn_id, name, type, size, created_at) VALUES ('f1','c1','u1',?1,'a.png','image/png',3,'t')").run(turn.value.id);
    db.close();
    const after = openDb(path, migrations);
    expect(after.query("SELECT conversation_id, turn_id, name FROM conversation_file").all()).toEqual([{ conversation_id: "c1", turn_id: turn.value.id, name: "a.png" }]);
    after.close();
  });
});

describe("the stopped-state migration", () => {
  test("a run stopped before it becomes stopped, a plain failed one stays failed, rows and indexes kept", () => {
    const at = migrationFiles.findIndex((m) => m.name === "20261104100000-conversation-run-stopped-state");
    expect(at).toBeGreaterThan(0);
    const path = join(dir, "runs.db");
    const db = openDb(path, migrationFiles.slice(0, at).map((m) => m.sql));
    db.query("INSERT INTO user (id, username, email, password_hash) VALUES ('u1','u1','u1@x','x')").run();
    db.query("INSERT INTO conversation (id, user_id, claude_session_id, created_at, updated_at) VALUES ('c1','u1','s','t','t')").run();
    const run = db.query("INSERT INTO conversation_run (id, conversation_id, user_id, state, prompt, started_at, stopped) VALUES (?1,'c1','u1',?2,'p','t',?3)");
    run.run("r1", "failed", 1);
    run.run("r2", "failed", 0);
    run.run("r3", "ok", 0);
    db.close();
    const after = openDb(path, migrations);
    expect(after.query("SELECT id, state, stopped FROM conversation_run ORDER BY id").all()).toEqual([
      { id: "r1", state: "stopped", stopped: 1 },
      { id: "r2", state: "failed", stopped: 0 },
      { id: "r3", state: "ok", stopped: 0 },
    ]);
    const indexes = after.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'conversation_run' AND name LIKE 'conversation_run_%' ORDER BY name").all();
    expect(indexes).toEqual([{ name: "conversation_run_running" }, { name: "conversation_run_spend" }]);
    after.close();
  });
});

describe("the mutation checks", () => {
  test("a cross-origin POST to New, Rename and Archive is refused and changes nothing", async () => {
    const c = newConversation(app.db, alice.id);
    const before = listConversations(app.db, alice.id).length;
    const evil = (path: string, form: Record<string, string>) =>
      fetch(`${servers.url}${path}`, { method: "POST", redirect: "manual", headers: { origin: "https://evil.example", cookie: cookie(alice) }, body: new URLSearchParams(form) });
    expect((await evil("/talk/new", {})).status).toBe(403);
    expect((await evil(`/talk/${c.id}/rename`, { title: "hijack" })).status).toBe(403);
    expect((await evil(`/talk/${c.id}/archive`, { archived: "1" })).status).toBe(403);
    expect(listConversations(app.db, alice.id).length).toBe(before);
    const kept = listConversations(app.db, alice.id).find((x) => x.id === c.id);
    expect(kept?.title).toBe("");
  });

  test("a read-only token is refused on POST and PATCH /api/v1/conversations", async () => {
    const ro = createToken(app.db, alice.id, "t", "ro").token;
    const rw = createToken(app.db, alice.id, "t", "rw").token;
    const c = newConversation(app.db, alice.id);
    const call = (method: string, path: string, token: string, body: unknown) =>
      fetch(`${servers.url}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const before = listConversations(app.db, alice.id).length;
    expect((await call("POST", "/api/v1/conversations", ro, {})).status).toBe(403);
    expect((await call("PATCH", `/api/v1/conversations/${c.id}`, ro, { archived: true })).status).toBe(403);
    expect(listConversations(app.db, alice.id).length).toBe(before);
    expect(listConversations(app.db, alice.id).find((x) => x.id === c.id)?.archivedAt).toBeNull();
    expect((await call("PATCH", `/api/v1/conversations/${c.id}`, rw, { archived: true })).status).toBe(200);
    expect((await fetch(`${servers.url}/api/v1/conversations`, { headers: { authorization: `Bearer ${ro}` } })).status).toBe(200);
  });

  test("GET /talk/stream is the stream, not a conversation called stream", async () => {
    const answer = await get("/talk/stream", alice);
    expect(answer.headers.get("content-type")).toContain("text/event-stream");
    await answer.body?.cancel();
  });
});

describe("the most a person holds", () => {
  test("every door refuses past the cap, and the others are untouched", async () => {
    const carol = await createUser(app.db, { origin: "seed", trusted: true, username: "carol", email: "carol@forge.local", password: "a-good-passphrase" });
    if (!carol.ok) throw new Error(carol.error);
    promote(app.db, carol.value);
    const c = carol.value;
    while (listConversations(app.db, c.id).length + listConversations(app.db, c.id, { archived: true }).length < CONVERSATIONS_MAX) {
      const made = createConversation(app.db, c.id);
      if (!made.ok) break;
    }
    const held = () => (app.db.query("SELECT COUNT(*) AS n FROM conversation WHERE user_id = ?1").get(c.id) as { n: number }).n;
    expect(held()).toBe(CONVERSATIONS_MAX);
    const refused = createConversation(app.db, c.id);
    expect(!refused.ok && refused.error).toBe("too_many");
    const page = await post("/talk/new", c, {});
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).not.toMatch(/^\/talk\/[0-9a-z]{6,}/);
    const viaApi = await api("POST", "/api/v1/conversations", c, {});
    expect(viaApi.status).toBe(409);
    expect(((await viaApi.json()) as { error: string }).error).toBe("too_many");
    const ctx = { app, auth: { user: c, via: "session" } } as never;
    const mcp = (await sayTool.run(ctx, c, { action: "new" })) as { ok: boolean; error?: string };
    expect(mcp.ok).toBe(false);
    expect(mcp.error).toBe("too_many");
    expect(held()).toBe(CONVERSATIONS_MAX);
    // Archiving does not free a place; another person is unaffected.
    expect(createConversation(app.db, alice.id).ok).toBe(true);
  });
});

describe("the MCP rename", () => {
  test("rename needs a title: without one the title is kept", async () => {
    const ctx = { app, auth: { user: alice, via: "session" } } as never;
    const made = newConversation(app.db, alice.id);
    renameConversation(app.db, alice.id, made.id, "Keep me");
    const answer = (await sayTool.run(ctx, alice, { action: "rename", conversation: made.id })) as { ok: boolean; error?: string };
    expect(answer.ok).toBe(false);
    expect(answer.error).toBe("invalid_title");
    expect(listConversations(app.db, alice.id).find((x) => x.id === made.id)?.title).toBe("Keep me");
  });
});

describe("search (#8823)", () => {
  test("a result links to its conversation at the matching turn, the page shows that turn, and nothing of another person's", async () => {
    const c = newConversation(app.db, alice.id);
    const t = appendTurn(app.db, alice.id, c.id, { role: "person", text: "remember the narwhal budget" });
    for (let i = 0; i < 70; i++) appendTurn(app.db, alice.id, c.id, { role: "agent", text: `later ${i}` });
    const turn = t.ok ? t.value.id : "";
    const theirs = newConversation(app.db, bob.id);
    appendTurn(app.db, bob.id, theirs.id, { role: "person", text: "bob's narwhal secret" });
    const found = await (await get("/talk?find=narwha", alice)).text();
    expect(found).toContain(`href="/talk/${c.id}?turn=${turn}#t-${turn}"`);
    expect(found).not.toContain(theirs.id);
    expect(found).not.toContain("secret");
    const opened = await (await get(`/talk/${c.id}?turn=${turn}`, alice)).text();
    expect(opened).toContain(`id="t-${turn}"`);
    expect(opened).toContain('data-paged="1"');
    expect((await get("/talk?find=zzzqqq", alice).then((r) => r.text()))).toContain("Nothing found");
  });

  test("a hit in the last turns is the latest page: unpaged, no Latest link; archived results are labelled", async () => {
    const c = newConversation(app.db, alice.id);
    const t = appendTurn(app.db, alice.id, c.id, { role: "person", text: "the kraken ledger" });
    appendTurn(app.db, alice.id, c.id, { role: "agent", text: "noted" });
    const turn = t.ok ? t.value.id : "";
    const opened = await (await get(`/talk/${c.id}?turn=${turn}`, alice)).text();
    expect(opened).toContain('data-paged="0"');
    expect(opened).not.toContain(">Latest</a>");
    expect(opened).toContain(`id="t-${turn}"`);
    archiveConversation(app.db, alice.id, c.id, true);
    const found = await (await get("/talk?find=kraken", alice)).text();
    expect(found).toContain("archived");
    expect(found).toContain('class="row"');
  });
});
