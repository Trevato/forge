/**
 * Proposal tokens through MCP and the terminal (#2148): mint, list and revoke,
 * writer-only, each door calling the one action the API calls.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { proposalOf } from "../src/core/proposal_token.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken, verifyToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const ORIGIN = "https://kid.example.com/";
const NOT_VISIBLE = "no such resource here, or it is not visible to you";

describe("proposal tokens through MCP and the terminal", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let lib: Repo;
  let aliceRw: string;
  let bobRw: string;

  const mcp = async (token: string, args: Record<string, unknown>) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "proposal_tokens", arguments: { repo: "alice/lib", ...args } },
      }),
    });
    const body = (await res.json()) as any;
    const text = body.result.content[0].text as string;
    return { error: body.result.isError === true, text, json: () => JSON.parse(text) };
  };

  function boot(username: string) {
    const terminal = headlessTerminal(140, 32);
    const user = getUserByName(app.db, username)!;
    const { app: tui } = createForgeApp(
      app,
      { sshUsername: "t", remoteAddress: "127.0.0.1", user },
      { terminal, exitHooks: false },
    );
    tui.start();
    const key = (k: string) => tui.dispatch({ type: "key", key: k, ctrl: false, alt: false, shift: false });
    return {
      text: () => tui.screen.toText(),
      press: async (...keys: string[]) => {
        keys.forEach(key);
        await settleApp(tui);
      },
      ctrlK: async () => {
        tui.dispatch({ type: "key", key: "k", ctrl: true, alt: false, shift: false });
        await settleApp(tui);
      },
      type: async (t: string) => {
        for (const ch of t) key(ch);
        await settleApp(tui);
      },
      stop: () => tui.stop(),
    };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-proposal-doors-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    servers = await serve(app);
    const people: User[] = [];
    for (const [username, first] of [["alice", true], ["bob", false]] as const) {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!made.ok) throw new Error(made.error);
      people.push(made.value);
    }
    [alice, bob] = people as [User, User];
    const made = await createRepo(app, alice, { name: "lib", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    lib = made.value;
    aliceRw = createToken(app.db, alice.id, "rw", "rw").token;
    bobRw = createToken(app.db, bob.id, "rw", "rw").token;
  });

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("MCP: mint shows the secret once, list never does, revoke ends it", async () => {
    const minted = await mcp(aliceRw, { verb: "mint", child: "kid", origin: ORIGIN });
    expect(minted.error).toBe(false);
    const { id, token } = minted.json();
    expect(token).toStartWith("forge_");
    expect(proposalOf(app.db, id)?.child).toBe("kid");
    const verified = verifyToken(app.db, token);
    expect(verified.ok && verified.value.proposal?.repoId).toBe(lib.id);

    const listed = await mcp(aliceRw, { verb: "list" });
    expect(listed.json()).toHaveLength(1);
    expect(listed.json()[0]).toMatchObject({ id, child: "kid", origin: ORIGIN });
    expect(listed.text).not.toContain(token);

    expect((await mcp(aliceRw, { verb: "revoke", id })).error).toBe(false);
    expect(proposalOf(app.db, id)).toBeUndefined();
    expect(verifyToken(app.db, token).ok).toBe(false);
    expect((await mcp(aliceRw, { verb: "list" })).json()).toEqual([]);
    expect((await mcp(aliceRw, { verb: "revoke", id })).error).toBe(true);
  });

  test("MCP: bad input is refused in the API's words", async () => {
    const bad = await mcp(aliceRw, { verb: "mint", child: "Kid", origin: ORIGIN });
    expect(bad.error).toBe(true);
    expect(bad.text).toContain("child is lowercase words and hyphens; origin is an https address");
    expect((await mcp(aliceRw, { verb: "mint", child: "kid", origin: "http://x.test/" })).error).toBe(true);
    expect((await mcp(aliceRw, { verb: "explode" })).error).toBe(true);
  });

  test("MCP: a non-writer is told what the API tells them", async () => {
    const api = await fetch(`${servers.url}/api/v1/repos/alice/lib/proposal-tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${bobRw}`, "content-type": "application/json" },
      body: JSON.stringify({ child: "kid", origin: ORIGIN }),
    });
    expect(api.status).toBe(404);
    const apiWords = ((await api.json()) as { message: string }).message;
    expect(apiWords).toBe(NOT_VISIBLE);

    const mine = (await mcp(aliceRw, { verb: "mint", child: "mine", origin: ORIGIN })).json();
    for (const args of [
      { verb: "mint", child: "kid", origin: ORIGIN },
      { verb: "list" },
      { verb: "revoke", id: mine.id },
    ]) {
      const refused = await mcp(bobRw, args);
      expect(refused.error).toBe(true);
      expect(refused.text).toContain(apiWords);
    }
    expect(proposalOf(app.db, mine.id)).toBeDefined();
    expect(app.db.query("SELECT COUNT(*) AS n FROM proposal_token").get()).toEqual({ n: 1 });
  });

  test("terminal: mint, list and revoke round trip", async () => {
    const before = app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM proposal_token").get()!.n;
    const h = boot("alice");
    await h.ctrlK();
    await h.type("Proposal tokens");
    await h.press("enter");
    await h.type("alice/lib");
    await h.press("enter");
    expect(h.text()).toContain("mine");

    await h.press("n");
    await h.type("terminal-kid");
    await h.press("enter");
    await h.type("https://tk.example.com/");
    await h.press("enter");
    expect(h.text()).toContain("Shown once");
    const row = app.db
      .query<{ token_id: string }, []>("SELECT token_id FROM proposal_token WHERE child = 'terminal-kid'")
      .get()!;
    expect(row).toBeDefined();
    expect(app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM proposal_token").get()!.n).toBe(before + 1);
    // The secret on screen is the one that works.
    const shown = /forge_[A-Za-z0-9_-]+/.exec(h.text())?.[0] ?? "";
    const verified = verifyToken(app.db, shown);
    expect(verified.ok && verified.value.proposal?.child).toBe("terminal-kid");

    await h.press("esc");
    expect(h.text()).toContain("terminal-kid");
    expect(h.text()).toContain("https://tk.example.com/");
    expect(h.text()).not.toContain(shown);

    // The earlier "mine" token is first; the new one is under the second row.
    await h.press("j");
    await h.press("x", "y");
    expect(proposalOf(app.db, row.token_id)).toBeUndefined();
    expect(h.text()).toContain("terminal-kid: revoked.");
    h.stop();
  });

  test("terminal: revoke removes the token under the cursor", async () => {
    const h = boot("alice");
    await h.ctrlK();
    await h.type("Proposal tokens");
    await h.press("enter");
    await h.type("alice/lib");
    await h.press("enter");
    const rows = app.db.query<{ child: string }, []>("SELECT child FROM proposal_token ORDER BY token_id").all();
    expect(rows.length).toBeGreaterThan(0);
    // Revoke every row: the cursor stays on the first.
    for (let i = 0; i < rows.length; i++) await h.press("x", "y");
    expect(h.text()).toContain("revoked");
    expect(app.db.query("SELECT 1 FROM proposal_token").all()).toEqual([]);
    h.stop();
  });

  test("terminal: a non-writer is refused with the API's words and nothing changes", async () => {
    const mine = (await mcp(aliceRw, { verb: "mint", child: "keep", origin: ORIGIN })).json();
    const h = boot("bob");
    await h.ctrlK();
    await h.type("Proposal tokens");
    await h.press("enter");
    await h.type("alice/lib");
    await h.press("enter");
    expect(h.text()).toContain(NOT_VISIBLE);
    expect(proposalOf(app.db, mine.id)).toBeDefined();
    h.stop();
  });
});
