/** `feed_dismiss` does what the card's menu does: `feed` then leaves the item out; a bad kind or an unseen item is refused. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { readFeed } from "../src/feed/feed.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

describe("MCP feed_dismiss", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let aliceTok: string;
  let bobTok: string;
  let id = 1;

  const call = async (token: string, name: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: id++,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const body: any = await res.json();
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-feed-dismiss-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string, first = false) => {
      const u = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!u.ok) throw new Error(u.error);
      promote(app.db, u.value);
      return u.value;
    };
    await mk("founder", true);
    alice = await mk("alice");
    bob = await mk("bob");
    aliceTok = createToken(app.db, alice.id, "rw", "rw").token;
    bobTok = createToken(app.db, bob.id, "rw", "rw").token;
    const open = await createRepo(app, alice, { name: "open", visibility: "public" });
    const secret = await createRepo(app, alice, { name: "secret", visibility: "private" });
    if (!open.ok || !secret.ok) throw new Error("repos");
    for (const [repo, summary] of [[open.value, "up"], [secret.value, "boom"]] as const)
      app.bus.append({
        kind: "run.finished",
        repoId: repo.id,
        actorId: alice.id,
        payload: { kind: "deploy", state: "ok", summary, runId: `r-${summary}` },
      });
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a dismissed item is no longer in the feed", async () => {
    const run = readFeed(app.db, bob).items.find((i) => i.id.startsWith("event:") && i.app === "alice/open")!;
    expect(run).toBeDefined();
    const done = await call(bobTok, "feed_dismiss", { item: run.id, kind: "dismissed" });
    expect(done.value.id).toBeString();
    const listed = await call(bobTok, "feed", {});
    expect(listed.value.items.some((i: { id: string }) => i.id === run.id)).toBe(false);
  });

  test("a bad kind or item is refused, and so is an item the caller cannot see", async () => {
    const secret = readFeed(app.db, alice).items.find((i) => i.app === "alice/secret")!;
    expect(secret).toBeDefined();
    expect((await call(aliceTok, "feed_dismiss", { item: secret.id, kind: "opened" })).error).toBeDefined();
    expect((await call(aliceTok, "feed_dismiss", { item: "../x", kind: "muted" })).error).toBeDefined();
    expect((await call(bobTok, "feed_dismiss", { item: secret.id, kind: "dismissed" })).error).toContain("no such item");
    expect((await call(bobTok, "feed_dismiss", { item: "ask:look:x", kind: "muted", app: "alice/secret" })).error).toContain("no such item");
    expect((await call(bobTok, "feed_dismiss", { item: "ask:look:x", kind: "muted", app: "alice/open" })).value.id).toBeString();
  });
});
