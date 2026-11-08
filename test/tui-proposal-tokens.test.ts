/**
 * Proposal tokens in the terminal (#6979): the secret shows once on its own
 * screen, only a writer mints, and a revoked token is refused by the API.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listProposals, repoByName } from "../src/actions/proposal_tokens.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const NOT_VISIBLE = "no such resource here, or it is not visible to you";
const count = (app: App) =>
  app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM proposal_token").get()!.n;

describe("proposal tokens in the terminal", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;

  function boot(username: string) {
    const terminal = headlessTerminal(140, 32);
    const user = getUserByName(app.db, username)!;
    const { app: tui } = createForgeApp(
      app,
      { sshUsername: "t", remoteAddress: "127.0.0.1", user },
      { terminal, exitHooks: false },
    );
    tui.start();
    const key = (k: string, ctrl = false) =>
      tui.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    return {
      text: () => tui.screen.toText(),
      press: async (...keys: string[]) => {
        keys.forEach((k) => key(k));
        await settleApp(tui);
      },
      type: async (t: string) => {
        for (const ch of t) key(ch);
        await settleApp(tui);
      },
      open: async function () {
        key("k", true);
        await settleApp(tui);
        await this.type("Proposal tokens");
        await this.press("enter");
        await this.type("alice/lib");
        await this.press("enter");
      },
      stop: () => tui.stop(),
    };
  }

  const asProposal = (token: string) =>
    fetch(`${servers.url}/api/v1/user`, { headers: { authorization: `Bearer ${token}` } });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-proposal-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    servers = await serve(app);
    let alice;
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
      alice ??= made.value;
    }
    const repo = await createRepo(app, alice!, { name: "lib", visibility: "public" });
    if (!repo.ok) throw new Error(String(repo.error));
  });

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("n mints; the secret shows once, then x revokes it and the API refuses it", async () => {
    const h = boot("alice");
    await h.open();
    expect(h.text()).toContain("None yet");

    await h.press("n");
    await h.type("kid-one");
    await h.press("enter");
    await h.type("https://kid.example.com/");
    await h.press("enter");

    const secret = /forge_[A-Za-z0-9_-]+/.exec(h.text())?.[0] ?? "";
    expect(secret).not.toBe("");
    expect(h.text()).toContain("Shown once");
    expect(count(app)).toBe(1);
    // A live proposal token is known but limited (403); a revoked one is nobody (401).
    expect((await asProposal(secret)).status).toBe(403);

    await h.press("esc");
    expect(h.text()).toContain("kid-one");
    expect(h.text()).toContain("https://kid.example.com/");
    expect(h.text()).not.toContain(secret);
    expect(h.text()).not.toContain("Shown once");

    await h.press("x");
    expect(h.text()).toContain("Revoke the token for kid-one?");
    expect(count(app)).toBe(1);
    await h.press("y");
    expect(h.text()).toContain("kid-one: revoked.");
    expect(h.text()).not.toContain(secret);
    expect(count(app)).toBe(0);
    expect((await asProposal(secret)).status).toBe(401);
    h.stop();
  });

  test("x asks first: n, esc or enter keeps the token listed", async () => {
    const h = boot("alice");
    await h.open();
    await h.press("n");
    await h.type("kid-two");
    await h.press("enter");
    await h.type("https://kid-two.example.com/");
    await h.press("enter");
    await h.press("esc");

    const listed = () => {
      const r = listProposals(app, getUserByName(app.db, "alice"), repoByName(app, "alice/lib"));
      return r.ok ? r.value.map((t) => t.child) : [];
    };
    expect(listed()).toEqual(["kid-two"]);

    await h.press("x");
    expect(h.text()).toContain("Revoke the token for kid-two?");
    expect(h.text()).toContain("kid-two can no longer propose here");
    await h.press("n");
    expect(h.text()).not.toContain("Revoke the token for");
    expect(h.text()).not.toContain("revoked.");
    expect(listed()).toEqual(["kid-two"]);

    await h.press("x", "esc");
    expect(listed()).toEqual(["kid-two"]);

    // The dialog starts on Keep: a stray enter revokes nothing.
    await h.press("x", "enter");
    expect(h.text()).not.toContain("Revoke the token for");
    expect(listed()).toEqual(["kid-two"]);

    await h.press("x", "y");
    expect(h.text()).toContain("kid-two: revoked.");
    expect(listed()).toEqual([]);
    h.stop();
  });

  test("x on an empty list asks nothing", async () => {
    const h = boot("alice");
    await h.open();
    expect(h.text()).toContain("None yet");
    await h.press("x");
    expect(h.text()).not.toContain("Revoke the token for");
    h.stop();
  });

  test("bad input mints nothing", async () => {
    const h = boot("alice");
    await h.open();
    await h.press("n");
    await h.type("Bad Name");
    await h.press("enter");
    await h.type("https://kid.example.com/");
    await h.press("enter");
    expect(h.text()).toContain("lowercase words and hyphens");
    expect(count(app)).toBe(0);
    h.stop();
  });

  test("a person who may not write the repository sees the refusal and mints nothing", async () => {
    const h = boot("bob");
    await h.open();
    expect(h.text()).toContain(NOT_VISIBLE);
    expect(h.text()).not.toContain("Tokens you minted");
    await h.press("n");
    expect(h.text()).not.toContain("Mint a proposal token");
    expect(count(app)).toBe(0);
    h.stop();
  });
});
