/**
 * share(item, to?): who needs to know, without widening access or adding
 * noise. Proven end to end on a real app: no widening, the daily budget and
 * its queue, dedupe, agent routing, sender weight, and the routes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { listComments } from "../src/core/issues.ts";
import { recordInteraction } from "../src/core/interactions.ts";
import type { Repo } from "../src/core/repos.ts";
import { pin } from "../src/core/pins.ts";
import { DAILY_BUDGET, QUEUE_TTL_MS, senderWeight } from "../src/core/shares.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { readFeed } from "../src/feed/feed.ts";
import { share } from "../src/feed/share.ts";
import { parseTargets } from "../src/http/feed.ts";
import { serve, type Servers } from "../src/http/server.ts";

const HOUR = 3600_000;

describe("share", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let carol: User;
  let bot: User;
  let aliceToken: string;
  let open: Repo;
  let secret: Repo;
  let n = 0;
  const emit = (repo: Repo, kind = "run.finished", payload: object = {}) =>
    `event:${app.bus.append({
      kind,
      repoId: repo.id,
      actorId: alice.id,
      payload: { kind: "deploy", state: "ok", summary: `run ${++n}`, runId: `r${n}`, ...payload },
    }).id}`;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-share-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string, first = false) => {
      const r = await createUser(app.db, { trusted: true,
        username,
        // Fixtures may name an account after a reserved word on purpose.
        allowReserved: true,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!r.ok) throw new Error(r.error);
      return r.value;
    };
    const root = await mk("root", true);
    alice = await mk("alice");
    bob = await mk("bob");
    carol = await mk("carol");
    const made = await createAgent(app, root, { username: "bot", brief: "Be brief." });
    if (!made.ok) throw new Error(String(made.error));
    bot = made.value.user;
    aliceToken = createToken(app.db, alice.id, "t", "rw").token;
    const o = await createRepo(app, alice, { name: "open", visibility: "public" });
    const s = await createRepo(app, alice, { name: "secret", visibility: "private" });
    if (!o.ok || !s.ok) throw new Error("repos");
    open = o.value;
    secret = s.value;
    expect(addToCrew(app, root, open, "bot").ok).toBe(true);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const sent = async (item: string, to: string[], who = alice, now?: number) => {
    const r = await share(app, who, item, to, now);
    if (!r.ok) throw new Error(r.error);
    return r.value.sent;
  };

  test("a share never widens access", async () => {
    const item = emit(secret);
    // Bob cannot read the private app: he is unreachable, and sees nothing.
    expect(await sent(item, ["bob"])).toEqual([{ to: "bob", outcome: "unreachable" }]);
    expect(readFeed(app.db, bob).items.some((i) => i.app === "alice/secret")).toBe(false);
    // A name that does not exist looks the same.
    expect(await sent(item, ["nobody"])).toEqual([{ to: "nobody", outcome: "unreachable" }]);
    // Nor can bob share what he cannot see.
    const r = await share(app, bob, item, ["carol"]);
    expect(r).toEqual({ ok: false, error: "not_found" });
  });

  test("a person gets a boosted item that says who shared it, once", async () => {
    const item = emit(open);
    expect(await sent(item, ["bob"])).toEqual([{ to: "bob", outcome: "delivered" }]);
    const items = readFeed(app.db, bob).items;
    const hit = items.find((i) => i.id.startsWith("share:"));
    expect(hit?.reason).toStartWith("shared by alice: ");
    expect(items.some((i) => i.id === item)).toBe(false);
    expect(items[0]?.id).toBe(hit!.id);
    // Dedupe: the same item to the same person again is not sent.
    expect(await sent(item, ["bob"])).toEqual([{ to: "bob", outcome: "duplicate" }]);
    expect(readFeed(app.db, bob).items.filter((i) => i.id.startsWith("share:")).length).toBe(1);
  });

  test("the daily budget queues the rest, and the queue decays", async () => {
    const t0 = Date.now();
    const items = Array.from({ length: DAILY_BUDGET + 2 }, () => emit(open));
    const outcomes: string[] = [];
    for (const it of items) outcomes.push((await sent(it, ["carol"], alice, t0))[0]!.outcome);
    expect(outcomes.filter((o) => o === "delivered").length).toBe(DAILY_BUDGET);
    expect(outcomes.filter((o) => o === "queued").length).toBe(2);
    const shares = (now: number) =>
      readFeed(app.db, carol, { now, limit: 50 }).items.filter((i) => i.id.startsWith("share:")).length;
    expect(shares(t0 + HOUR)).toBe(DAILY_BUDGET);
    // A day on, the budget is back and the queue moves.
    expect(shares(t0 + 25 * HOUR)).toBe(DAILY_BUDGET + 2);
  });

  test("a queued share that waits too long is dropped", async () => {
    const t0 = Date.now();
    const dave = await createUser(app.db, { trusted: true,
      username: "dave",
      email: "dave@forge.local",
      password: "a-good-passphrase",
    });
    if (!dave.ok) throw new Error(dave.error);
    // Spend dave's day with shares from carol-less alice, then queue one.
    for (let i = 0; i < DAILY_BUDGET; i++) await sent(emit(open), ["dave"], alice, t0 + 40 * HOUR);
    const late = await sent(emit(open), ["dave"], alice, t0 + 40 * HOUR);
    expect(late[0]!.outcome).toBe("queued");
    // Past the ttl with the budget spent again by fresh shares, it is gone.
    const way = t0 + 40 * HOUR + QUEUE_TTL_MS + HOUR;
    const feed = readFeed(app.db, dave.value, { now: way, limit: 50 });
    expect(feed.items.filter((i) => i.id.startsWith("share:")).length).toBe(DAILY_BUDGET);
    const state = app.db
      .query<{ state: string }, [string]>("SELECT state FROM share WHERE recipient_id = ?1 AND state = 'dropped'")
      .all(dave.value.id);
    expect(state.length).toBe(1);
  });

  test("muting the app is a strong no", async () => {
    recordInteraction(app.db, {
      viewerId: bob.id,
      itemId: "app:x",
      kind: "muted",
      repoId: open.id,
      actorId: null,
    });
    expect(await sent(emit(open), ["bob"])).toEqual([{ to: "bob", outcome: "skipped" }]);
  });

  test("an agent is steered on a change, told otherwise", async () => {
    const issue = openIssue(app, alice, open, { title: "Plant tulips", body: "" });
    if (!issue.ok) throw new Error(String(issue.error));
    const change = emit(open, "pull.opened", { number: issue.value.number });
    expect(await sent(change, ["bot"])).toEqual([{ to: "bot", outcome: "steered" }]);
    const said = listComments(app.db, issue.value.id).map((c) => c.body);
    expect(said.some((b) => b.startsWith("Shared by alice with bot:"))).toBe(true);
    // Not twice.
    expect(await sent(change, ["bot"])).toEqual([{ to: "bot", outcome: "duplicate" }]);
    const plain = emit(open);
    expect(await sent(plain, ["bot"])).toEqual([{ to: "bot", outcome: "told" }]);
  });

  test("with no target it goes to crew and owners, then followers", async () => {
    const item = emit(open);
    // Alice owns it and bot is on the crew: she is the sender, so bot only.
    expect((await sent(item, [])).map((s) => s.to)).toEqual(["bot"]);
    // Bob (not an owner) shares: crew and the owner are both reached.
    const item2 = emit(open);
    expect((await sent(item2, [], bob)).map((s) => s.to).sort()).toEqual(["alice", "bot"]);
    // When only the sender is left, the followers hear it.
    const lone = await createRepo(app, alice, { name: "lone", visibility: "public" });
    if (!lone.ok) throw new Error("repo");
    const erin = await createUser(app.db, { trusted: true, username: "erin", email: "e@forge.local", password: "a-good-passphrase" });
    if (!erin.ok) throw new Error("user");
    pin(app.db, erin.value.id, lone.value.id);
    const item3 = emit(lone.value);
    expect(await sent(item3, [])).toEqual([{ to: "erin", outcome: "delivered" }]);
  });

  test("a sender who is opened rises, one who is not sinks", async () => {
    const mk = async (username: string) => {
      const r = await createUser(app.db, { trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase" });
      if (!r.ok) throw new Error("user");
      return r.value;
    };
    const sender = await mk("sender");
    const reader = await mk("reader");
    expect(senderWeight(app.db, sender.id, Date.now())).toBe(1);
    const items = [] as string[];
    for (let i = 0; i < 4; i++) {
      items.push(emit(open));
      await sent(items[i]!, ["reader"], sender);
    }
    const ignored = senderWeight(app.db, sender.id, Date.now());
    expect(ignored).toBeLessThan(0.5);
    for (const it of items)
      recordInteraction(app.db, { viewerId: reader.id, itemId: it, kind: "opened", repoId: open.id, actorId: null });
    expect(senderWeight(app.db, sender.id, Date.now())).toBeGreaterThan(1.5);
  });

  test("the route validates, checks scope and answers", async () => {
    const item = emit(open);
    const post = (token: string | undefined, payload: unknown) =>
      fetch(`${servers.url}/api/v1/share`, {
        method: "POST",
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    expect((await post(undefined, { item })).status).toBe(401);
    expect((await post(aliceToken, { item: "nope" })).status).toBe(422);
    expect((await post(aliceToken, { item, to: [1] })).status).toBe(422);
    expect((await post(aliceToken, { item, to: "bad name!" })).status).toBe(422);
    expect((await post(aliceToken, { item: "event:missing" })).status).toBe(404);
    const ok = await post(aliceToken, { item, to: ["carol"] });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toEqual({ sent: [{ to: "carol", outcome: expect.any(String) }] });
    const ro = createToken(app.db, alice.id, "ro", "ro").token;
    expect((await post(ro, { item, to: ["carol"] })).status).toBe(403);
  });

  test("parseTargets accepts names and refuses the rest", () => {
    expect(parseTargets(undefined)).toEqual([]);
    expect(parseTargets("@bob")).toEqual(["bob"]);
    expect(parseTargets(["a", "b"])).toEqual(["a", "b"]);
    expect(parseTargets({})).toBeUndefined();
    expect(parseTargets(Array(11).fill("a"))).toBeUndefined();
  });

  test("it is a tool on the MCP door", async () => {
    const item = emit(open);
    const call = (name: string, args: object) =>
      fetch(`${servers.url}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${aliceToken}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      }).then((r) => r.json() as Promise<{ result: { isError?: boolean; content: { text: string }[] } }>);
    const r = await call("share", { item, to: ["carol"] });
    expect(r.result.isError).toBeFalsy();
    expect(r.result.content[0]!.text).toContain("carol");
  });
});
