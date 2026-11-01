/**
 * Adding and removing a crew subscription in the terminal (#7551), as MCP
 * `subscription_add` and `subscription_delete` do; no frame carries a token.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { addSubscription, deleteSubscription, listSubscriptions, subscriptionAad } from "../src/core/subscriptions.ts";
import { open as unseal } from "../src/kernel/secret.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { subscriptionsScreen } from "../src/tui/screens/subscriptions.ts";
import { Session } from "../src/tui/session.ts";
import type { Ctx } from "../src/tui/app/app.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp, settleUntil } from "./helpers/tui.ts";

quietLogs();

const TOKEN = "sk-ant-oat01-secretgamma";

describe("adding and removing a subscription in the terminal", () => {
  let dataDir: string;
  let forge: Forge;

  function boot(username: string) {
    const frames: string[] = [];
    const terminal = headlessTerminal(140, 32);
    const user = getUserByName(forge.db, username)!;
    const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user };
    const { app } = createForgeApp(forge, identity, { terminal, exitHooks: false });
    app.start();
    const key = (k: string) => app.dispatch({ type: "key", key: k, ctrl: false, alt: false, shift: false });
    const seen = () => frames.push(app.screen.toText());
    return {
      text: () => app.screen.toText(),
      frames,
      press: async (...keys: string[]) => {
        for (const k of keys) {
          key(k);
          seen();
        }
        await settleApp(app);
        seen();
      },
      ctrl: async (k: string) => {
        app.dispatch({ type: "key", key: k, ctrl: true, alt: false, shift: false });
        await settleApp(app);
      },
      type: async (t: string) => {
        for (const ch of t) {
          key(ch);
          seen();
        }
        await settleApp(app);
        seen();
      },
      until: (what: string) => settleUntil(app, what, { timeoutMs: 4_000 }),
      stop: () => app.stop(),
    };
  }

  const open = async (h: ReturnType<typeof boot>) => {
    await h.ctrl("k");
    await h.type("Crew subscriptions");
    await h.until("each account's budget");
    await h.press("enter");
    await h.until("a adds");
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-subadd-"));
    forge = createApp({ dataDir, port: 0 });
    for (const [username, adminIfFirst] of [["alice", true], ["bob", false]] as const) {
      const made = await createUser(forge.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst,
      });
      if (!made.ok) throw new Error(made.error);
    }
  });
  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("adds one with refusals in words, never drawing the token; D asks first", async () => {
    const h = boot("alice");
    await open(h);
    await h.press("a");
    await h.until("Add a Claude account");
    await h.type("bad/name");
    await h.press("enter");
    await h.until("A name is a word or two");
    await h.press("esc", "a");
    await h.type("gamma");
    await h.press("enter");
    await h.until("Token for gamma");
    await h.type(TOKEN);
    await h.press("enter");
    await h.until("API base for gamma");
    await h.type("http://nope");
    await h.press("enter");
    await h.until("The API base URL must be https");
    expect(listSubscriptions(forge.db)).toHaveLength(0);
    await h.press("backspace");
    for (let i = 0; i < 10; i++) await h.press("backspace");
    await h.press("enter");
    await h.until("gamma is in the pool.");
    expect(listSubscriptions(forge.db).map((s) => s.name)).toEqual(["gamma"]);
    expect(h.text()).toContain("gamma");
    for (const frame of h.frames) expect(frame).not.toContain("secretgamma");

    await h.press("a");
    await h.type("empty");
    await h.press("enter");
    await h.until("Token for empty");
    await h.press("enter");
    await h.until("That token is empty or over 4096 characters");
    expect(listSubscriptions(forge.db)).toHaveLength(1);
    await h.press("esc", "a");
    await h.type("gamma");
    await h.press("enter");
    await h.type(TOKEN);
    await h.press("enter");
    await h.press("enter");
    await h.until("There is already a subscription called gamma.");
    await h.press("esc");

    await h.press("D");
    await h.until("Remove gamma?");
    expect(h.text()).toContain("keep it in their history");
    await h.press("esc");
    expect(listSubscriptions(forge.db)).toHaveLength(1);
    await h.press("D");
    await h.until("Remove gamma?");
    await h.press("enter"); // the default is Cancel
    expect(listSubscriptions(forge.db)).toHaveLength(1);
    await h.press("D");
    await h.until("Remove gamma?");
    await h.press("left", "enter");
    await h.until("gamma is removed.");
    expect(listSubscriptions(forge.db)).toHaveLength(0);
    for (const frame of h.frames) expect(frame).not.toContain("secretgamma");
    h.stop();
  });

  test("a key pasted with a Bearer prefix and a space is sealed cleaned, as on the page and in MCP", async () => {
    const h = boot("alice");
    await open(h);
    await h.press("a");
    await h.type("pasted");
    await h.press("enter");
    await h.until("Token for pasted");
    await h.type("Bearer sk-ant-oat01-secret pasted");
    await h.press("enter");
    await h.until("API base for pasted");
    await h.press("enter");
    await h.until("pasted is in the pool.");
    const [sub] = listSubscriptions(forge.db).filter((s) => s.name === "pasted");
    // Judged after cleaning: with the prefix kept it would be taken as an API key.
    expect(sub!.kind).toBe("oauth");
    const row = forge.db
      .query<{ token_enc: string }, [string]>("SELECT token_enc FROM subscription WHERE id = ?")
      .get(sub!.id)!;
    expect(unseal(dataDir, row.token_enc, subscriptionAad(sub!.id))).toEqual({ ok: true, value: "sk-ant-oat01-secretpasted" });
    deleteSubscription(forge.db, sub!.id);
    h.stop();
  });

  test("an agent that is an admin is offered nothing and changes nothing", async () => {
    forge.db.query("UPDATE user SET is_agent = 1 WHERE username = 'alice'").run();
    const h = boot("alice");
    await h.ctrl("k");
    await h.type("Crew subscriptions");
    await h.until("Crew subscriptions");
    expect(h.text()).not.toContain("each account's budget");
    h.stop();
    forge.db.query("UPDATE user SET is_agent = 0 WHERE username = 'alice'").run();
  });

  test("a person admin sees a token-free list; a non-admin's a and D do nothing", async () => {
    const pushed: unknown[] = [];
    const ctx = { push: (x: unknown) => pushed.push(x), invalidate() {}, pop() {} } as unknown as Ctx;
    const made = addSubscription(forge.db, dataDir, { name: "delta", token: TOKEN });
    if (!made.ok) throw new Error(made.error);
    const key = (k: string) => ({ type: "key" as const, key: k, ctrl: false, alt: false, shift: false });
    const session = (name: string) =>
      new Session(forge, { sshUsername: "t", remoteAddress: "127.0.0.1", user: getUserByName(forge.db, name)! });
    const bob = subscriptionsScreen(session("bob"), ctx);
    expect(bob.key(key("a"))).toBe(false);
    expect(bob.key(key("D"))).toBe(false);
    expect(pushed).toHaveLength(0);
    const alice = subscriptionsScreen(session("alice"), ctx);
    expect(alice.key(key("D"))).toBe(true);
    expect(pushed).toHaveLength(1);
    expect(listSubscriptions(forge.db)).toHaveLength(1);
    const h = boot("alice");
    await open(h);
    expect(h.text()).toContain("delta");
    expect(h.text()).not.toContain("secretgamma");
    h.stop();
    deleteSubscription(forge.db, made.value.id);
  });
});
