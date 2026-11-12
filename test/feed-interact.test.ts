/**
 * Who may dismiss a feed item or mute its app (#7524): `interactionTarget`
 * and `readInteraction` (src/feed/interact.ts) are the one rule, and the
 * route and MCP `feed_dismiss` refuse the same inputs with the same error.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { readFeed } from "../src/feed/feed.ts";
import { interactionTarget, NO_SUCH_ITEM, readInteraction } from "../src/feed/interact.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let alice: User;
let bob: User;
let bobTok: string;
let open: Repo;
let secret: Repo;
let openEvent: string;
let secretEvent: string;

const DISMISS = ["dismissed", "muted"] as const;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-feed-interact-"));
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
  bobTok = createToken(app.db, bob.id, "rw", "rw").token;
  const o = await createRepo(app, alice, { name: "open", visibility: "public" });
  const s = await createRepo(app, alice, { name: "secret", visibility: "private" });
  if (!o.ok || !s.ok) throw new Error("repos");
  open = o.value;
  secret = s.value;
  for (const [repo, summary] of [[open, "up"], [secret, "boom"]] as const)
    app.bus.append({
      kind: "run.finished",
      repoId: repo.id,
      actorId: alice.id,
      payload: { kind: "deploy", state: "ok", summary, runId: `r-${summary}` },
    });
  const items = readFeed(app.db, alice).items.filter((i) => i.id.startsWith("event:"));
  openEvent = items.find((i) => i.app === "alice/open")!.id;
  secretEvent = items.find((i) => i.app === "alice/secret")!.id;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("interactionTarget", () => {
  test("an event on a repository the viewer can read resolves to its app and actor", () => {
    expect(interactionTarget(app.db, bob, openEvent, "")).toEqual({
      repoId: open.id,
      actorId: alice.id,
    });
  });

  test("an event the viewer cannot read is refused exactly as an unknown one", () => {
    expect(interactionTarget(app.db, alice, secretEvent, "")).toBeDefined();
    expect(interactionTarget(app.db, bob, secretEvent, "")).toBeUndefined();
    expect(interactionTarget(app.db, bob, "event:nothing-here", "")).toBeUndefined();
    // Naming a readable app does not open an unreadable event.
    expect(interactionTarget(app.db, bob, secretEvent, "alice/open")).toBeUndefined();
  });

  test("an item that is not an event needs a readable `app`", () => {
    expect(interactionTarget(app.db, bob, "ask:look:x", "alice/open")).toEqual({
      repoId: open.id,
      actorId: null,
    });
    for (const app_ of ["", "alice", "alice/open/x", "/open", "alice/", "nobody/none", "alice/secret"])
      expect(interactionTarget(app.db, bob, "ask:look:x", app_)).toBeUndefined();
    expect(interactionTarget(app.db, alice, "ask:look:x", "alice/secret")?.repoId).toBe(secret.id);
  });
});

describe("readInteraction", () => {
  test("a kind outside the door's own is refused", () => {
    for (const kind of ["opened", "bogus", "", undefined, 1])
      expect(readInteraction(app.db, bob, { item: openEvent, kind }, DISMISS)).toEqual({
        ok: false,
        error: { code: "invalid_kind", message: "kind is one of dismissed, muted" },
      });
  });

  test("a bad item id is refused before anything is looked up", () => {
    for (const item of ["../x", "", "event", 7])
      expect(readInteraction(app.db, bob, { item, kind: "muted" }, DISMISS)).toEqual({
        ok: false,
        error: { code: "invalid_item", message: "item is a feed item id" },
      });
  });

  test("what the viewer cannot read is not_found, worded as nothing", () => {
    const refused = { ok: false, error: { code: "not_found", message: NO_SUCH_ITEM } } as const;
    expect(readInteraction(app.db, bob, { item: secretEvent, kind: "muted" }, DISMISS)).toEqual(refused);
    expect(readInteraction(app.db, bob, { item: "event:nothing-here", kind: "muted" }, DISMISS)).toEqual(refused);
    expect(readInteraction(app.db, bob, { item: "ask:look:x", kind: "muted" }, DISMISS)).toEqual(refused);
  });

  test("a readable item resolves to the act", () => {
    expect(readInteraction(app.db, bob, { item: openEvent, kind: "dismissed" }, DISMISS)).toEqual({
      ok: true,
      value: { itemId: openEvent, kind: "dismissed", target: { repoId: open.id, actorId: alice.id } },
    });
  });
});

describe("the route and MCP feed_dismiss refuse the same things", () => {
  const route = async (input: unknown) => {
    const res = await fetch(`${servers.url}/api/v1/feed/interactions`, {
      method: "POST",
      headers: { authorization: `Bearer ${bobTok}`, "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const body = (await res.json()) as { error?: string; message?: string; id?: string };
    return { status: res.status, ...body };
  };
  const mcp = async (input: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${bobTok}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "feed_dismiss", arguments: input },
      }),
    });
    const body: any = await res.json();
    return { isError: body.result.isError === true, text: body.result.content[0].text as string };
  };

  test("each refused input gets the same code and words at both doors", async () => {
    const refused: [Record<string, unknown>, string][] = [
      [{ item: "../x", kind: "muted" }, "invalid_item"],
      [{ kind: "muted" }, "invalid_item"],
      [{ item: secretEvent, kind: "dismissed" }, "not_found"],
      [{ item: "event:nothing-here", kind: "dismissed" }, "not_found"],
      [{ item: "ask:look:x", kind: "muted" }, "not_found"],
      [{ item: "ask:look:x", kind: "muted", app: "alice" }, "not_found"],
      [{ item: "ask:look:x", kind: "muted", app: "alice/open/x" }, "not_found"],
      [{ item: "ask:look:x", kind: "muted", app: "alice/secret" }, "not_found"],
    ];
    for (const [input, code] of refused) {
      const web = await route(input);
      const tool = await mcp(input);
      expect({ input, code: web.error }).toEqual({ input, code });
      expect(web.status).toBe(code === "not_found" ? 404 : 422);
      expect(tool).toEqual({ isError: true, text: `${web.error}: ${web.message}` });
    }
  });

  test("a kind neither door knows is invalid_kind at both, each naming its own kinds", async () => {
    const input = { item: openEvent, kind: "bogus" };
    const web = await route(input);
    const tool = await mcp(input);
    expect(web.status).toBe(422);
    expect(web.error).toBe("invalid_kind");
    expect(tool).toEqual({ isError: true, text: "invalid_kind: kind is one of dismissed, muted" });
    // The route records every act a card reports; the tool only dismisses or mutes.
    expect((await route({ item: openEvent, kind: "opened" })).status).toBe(201);
    expect((await mcp({ item: openEvent, kind: "opened" })).text).toStartWith("invalid_kind:");
  });

  test("what one door accepts, the other does too", async () => {
    const input = { item: "ask:look:y", kind: "muted", app: "alice/open" };
    expect((await route(input)).status).toBe(201);
    expect((await mcp(input)).isError).toBe(false);
  });
});
