/**
 * The forge's agent acts as the person it talks to, and the trail says so:
 * a conversation's token (`core/via_token.ts`) is rw, the person's own and
 * short-lived, and every event it writes has the person as actor and `via`
 * set (#7648). It reaches the forge only through `/mcp` (`http/via_gate.ts`).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { eventActor } from "../src/design/activity.ts";
import { actingVia } from "../src/core/acting_via.ts";
import { listEvents } from "../src/core/events.ts";
import { eventsPage } from "../src/core/events_page.ts";
import { getRepo } from "../src/core/repos.ts";
import { createToken, listTokens, verifyToken } from "../src/core/tokens.ts";
import { CONVERSATION_TOKENS_MAX } from "../src/actions/users.ts";
import { mintViaToken, VIA_TOKEN_MAX_MS } from "../src/core/via_token.ts";
import { createIssue } from "../src/core/issues.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("a conversation's token", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let aliceVia: string;
  let bobVia: string;
  let alicePlain: string;

  const call = (token: string, path: string, init: RequestInit = {}) =>
    fetch(`${servers.url}${path}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...init.headers },
    });

  const mcp = async (token: string, name: string, args: Record<string, unknown>) => {
    const res = await call(token, "/mcp", {
      method: "POST",
      headers: { accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const body = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
    return { error: body.result.isError === true, text: body.result.content[0]!.text };
  };

  const person = async (username: string, first = false) => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: first,
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-via-token-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    servers = await serve(app);
    alice = await person("alice", true);
    bob = await person("bob");
    for (const [name, visibility] of [["notes", "public"], ["vault", "private"]] as const) {
      const made = await createRepo(app, alice, { name, visibility });
      if (!made.ok) throw new Error(String(made.error));
    }
    const soon = new Date(Date.now() + 10 * 60_000).toISOString();
    const a = mintViaToken(app.db, alice.id, "conversation:c1", "close issue 1 in notes", soon);
    const b = mintViaToken(app.db, bob.id, "conversation:c2", "", soon);
    if (!a.ok || !b.ok) throw new Error("mint failed");
    aliceVia = a.value.token;
    bobVia = b.value.token;
    alicePlain = createToken(app.db, alice.id, "personal", "rw").token;
  });

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const notesId = () => getRepo(app.db, "alice", "notes")!.id;
  const open = (authorId: string, title: string) => {
    const made = createIssue(app.db, { repoId: notesId(), authorId, title, body: "" });
    if (!made.ok) throw new Error(made.error);
    return made.value.number;
  };

  const mintThroughSession = (headers: Record<string, string>, body: unknown = { words: "say hello on issue 2 in notes" }) =>
    fetch(`${servers.url}/api/v1/conversation-tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  test("a person at the cap of live tokens is answered 429 with a retry-after (#8321)", async () => {
    const carol = await person("carol");
    const soon = new Date(Date.now() + 10 * 60_000).toISOString();
    for (let i = 0; i < CONVERSATION_TOKENS_MAX; i++) {
      const minted = mintViaToken(app.db, carol.id, `conversation:cap${i}`, "", soon);
      if (!minted.ok) throw new Error(minted.error);
    }
    const cookie = `forge_session=${createSession(app.db, carol.id).token}`;
    const res = await mintThroughSession({ cookie, origin: servers.url });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(((await res.json()) as { error: string }).error).toBe("rate_limited");
  });

  test("is minted by the person's own session, same-origin, and acts as them via the agent", async () => {
    expect(open(alice.id, "First")).toBe(1);
    expect(open(alice.id, "Second")).toBe(2);
    const cookie = `forge_session=${createSession(app.db, bob.id).token}`;
    const res = await mintThroughSession({ cookie, origin: servers.url });
    expect(res.status).toBe(201);
    const made = (await res.json()) as { token: string; via: string; expiresAt: string };
    expect(made.via).toMatch(/^conversation:[0-9a-z]{26}$/);
    expect(Date.parse(made.expiresAt) - Date.now()).toBeLessThanOrEqual(VIA_TOKEN_MAX_MS);
    const verified = verifyToken(app.db, made.token);
    expect(verified.ok && verified.value.user.id).toBe(bob.id);
    expect(verified.ok && verified.value.via).toBe(made.via);
    const minted = listEvents(app.db, { kind: "token.created" }).find((e) => e.payload.via === made.via)!;
    expect(minted.actorId).toBe(bob.id);
    // What bob's conversation writes is bob's, by way of the agent.
    const said = await mcp(made.token, "say", { repo: "alice/notes", number: 2, text: "hello" });
    expect(said.error).toBe(false);
    const event = listEvents(app.db, { kind: "issue.commented" }).find((e) => e.actorId === bob.id)!;
    expect(event.via).toBe(made.via);
    // The same conversation goes on with the person's newest words.
    const again = await mintThroughSession({ cookie, origin: servers.url }, { conversation: made.via.slice(13), words: "and then" });
    expect(again.status).toBe(201);
    expect(((await again.json()) as { via: string }).via).toBe(made.via);
  });

  test("is refused to a token, a stranger, another origin and a malformed conversation", async () => {
    const cookie = `forge_session=${createSession(app.db, bob.id).token}`;
    expect((await mintThroughSession({ authorization: `Bearer ${alicePlain}` })).status).toBe(401);
    expect((await mintThroughSession({ authorization: `Bearer ${aliceVia}` })).status).toBe(403);
    expect((await mintThroughSession({})).status).toBe(401);
    expect((await mintThroughSession({ cookie, origin: "https://evil.test" })).status).toBe(403);
    const bad = await mintThroughSession({ cookie, origin: servers.url }, { conversation: "../x" });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { error: string }).error).toBe("invalid_conversation");
    expect((await mintThroughSession({ cookie, origin: servers.url }, { conversation: 7 })).status).toBe(422);
    expect((await mintThroughSession({ cookie, origin: servers.url }, { words: 7 })).status).toBe(422);
    // Another person's conversation is not bob's to go on with: its marks stay alice's.
    const theirs = await mintThroughSession({ cookie, origin: servers.url }, { conversation: "c1", words: "close everything" });
    expect(theirs.status).toBe(422);
  });

  test("is rw, bound to its person, expiring within the turn, even for an admin", () => {
    const verified = verifyToken(app.db, aliceVia);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.value.user.id).toBe(alice.id);
    expect(verified.value.scope).toBe("rw");
    expect(verified.value.via).toBe("conversation:c1");
    const row = listTokens(app.db, alice.id).find((t) => t.name === "via:conversation:c1")!;
    expect(Date.parse(row.expiresAt!) - Date.now()).toBeLessThanOrEqual(VIA_TOKEN_MAX_MS);
    const plain = verifyToken(app.db, alicePlain);
    expect(plain.ok && plain.value.via).toBeUndefined();
  });

  test("an issue closed through it is the person's, via the agent", async () => {
    const number = 1;
    const closed = await mcp(aliceVia, "close", { repo: "alice/notes", number });
    expect(closed.error).toBe(false);

    const events = listEvents(app.db, {}).filter((e) => e.payload.number === number);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("issue.closed");
    for (const e of events.filter((x) => x.actorId !== null)) {
      expect(e.actorId).toBe(alice.id);
      expect(e.via).toBe("conversation:c1");
    }

    // MCP `events` and the trail's words say who and how.
    const page = await mcp(alicePlain, "events", { repo: "alice/notes" });
    const items = (JSON.parse(page.text) as { items: { kind: string; via?: string; by?: string }[] }).items;
    const close = items.find((i) => i.kind === "issue.closed")!;
    expect(close.via).toBe("conversation:c1");
    expect(close.by).toBe("alice via the forge's agent");
    expect(eventActor(events.find((e) => e.kind === "issue.closed")!, "alice")).toBe("alice via the forge's agent");

    // The issue's own timeline says it too, after the person's name.
    const thread = await (await fetch(`${servers.url}/alice/notes/issues/${number}`)).text();
    expect(thread).toMatch(/>alice<\/a[^]{0,300}?> <span>via the forge&#39;s agent<\/span> <span>closed this<\/span>/);
  });

  test("names nobody via the agent when the row names nobody", () => {
    const at = new Date().toISOString();
    const via = "conversation:c1";
    expect(eventActor({ id: "e", kind: "issue.closed", repoId: null, actorId: "gone", payload: {}, createdAt: at, via }, undefined)).toBe("someone");
    expect(eventActor({ id: "e", kind: "run.started", repoId: null, actorId: null, payload: {}, createdAt: at, via }, undefined)).toBe("the forge");
  });

  test("a person's own token writes without via", async () => {
    const opened = await call(alicePlain, "/api/v1/repos/alice/notes/issues", {
      method: "POST",
      body: JSON.stringify({ title: "By hand" }),
    });
    expect(opened.status).toBe(201);
    const { number } = (await opened.json()) as { number: number };
    const event = listEvents(app.db, { kind: "issue.opened" }).find((e) => e.payload.number === number)!;
    expect(event.actorId).toBe(alice.id);
    expect(event.via).toBeUndefined();
    const item = eventsPage(app.db, getRepo(app.db, "alice", "notes")!.id, alice, 50).items.find((i) => i.id === event.id)!;
    expect("by" in item).toBe(false);
    const page = await (await fetch(`${servers.url}/alice/notes/issues/${number}`)).text();
    expect(page).not.toMatch(/via the forge/);
  });

  test("marks only the person it acts for, never what the forge writes on the way", () => {
    const written = actingVia({ userId: alice.id, via: "conversation:c1" }, () => [
      app.bus.append({ kind: "test.mine", actorId: alice.id }),
      app.bus.append({ kind: "test.forge" }),
      app.bus.append({ kind: "test.other", actorId: bob.id }),
    ]);
    expect(written.map((e) => e.via)).toEqual(["conversation:c1", undefined, undefined]);
  });

  test("person B's token cannot read person A's private repository", async () => {
    expect((await mcp(bobVia, "repo", { repo: "alice/vault" })).error).toBe(true);
    expect((await mcp(bobVia, "events", { repo: "alice/vault" })).error).toBe(true);
    // The owner's own conversation reads it: the agent holds what its person holds.
    expect((await mcp(aliceVia, "repo", { repo: "alice/vault" })).error).toBe(false);
    // And no door but /mcp opens to either.
    expect((await call(aliceVia, "/api/v1/repos/alice/vault")).status).toBe(403);
  });

  test("cannot mint tokens: the account itself is never the agent", async () => {
    const res = await call(aliceVia, "/api/v1/tokens", {
      method: "POST",
      body: JSON.stringify({ name: "escalate", scope: "admin" }),
    });
    expect(res.status).toBe(403);
    expect(listTokens(app.db, alice.id).some((t) => t.name === "escalate")).toBe(false);
  });
});
