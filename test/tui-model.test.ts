/**
 * Model budget in the terminal (#1145): a person sees their own line and adds
 * their own subscription; only an admin who is a person has the grant command.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { getAccountCeiling } from "../src/core/account_ceiling.ts";
import { getModelGrant, ownSubscription } from "../src/core/model_grant.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("model budget in the terminal", () => {
  let dataDir: string;
  let forge: Forge;

  function boot(username: string) {
    const terminal = headlessTerminal(140, 32);
    const user = getUserByName(forge.db, username)!;
    const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user };
    const { app } = createForgeApp(forge, identity, { terminal, exitHooks: false });
    app.start();
    const key = (k: string) => app.dispatch({ type: "key", key: k, ctrl: false, alt: false, shift: false });
    return {
      text: () => app.screen.toText(),
      press: async (...keys: string[]) => {
        keys.forEach(key);
        await settleApp(app);
      },
      ctrl: async (k: string) => {
        app.dispatch({ type: "key", key: k, ctrl: true, alt: false, shift: false });
        await settleApp(app);
      },
      type: async (t: string) => {
        for (const ch of t) key(ch);
        await settleApp(app);
      },
      stop: () => app.stop(),
    };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-model-"));
    forge = createApp({ dataDir, port: 0 });
    for (const [username, adminIfFirst] of [["alice", true], ["bob", false]] as const) {
      const made = await createUser(forge.db, {
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

  const open = async (h: ReturnType<typeof boot>, title: string) => {
    await h.ctrl("k");
    await h.type(title);
    await h.press("enter");
  };

  test("a person sees budget zero and adds their own subscription", async () => {
    const h = boot("bob");
    await open(h, "Model budget");
    expect(h.text()).toContain("Model budget: $0.");
    await h.press("a");
    await h.type("sk-ant-api03-bobkey");
    await h.press("enter");
    await h.press("enter");
    const bob = getUserByName(forge.db, "bob")!;
    expect(ownSubscription(forge.db, bob.id)).toBeDefined();
    expect(h.text()).toContain("own subscription");
    expect(h.text()).not.toContain("sk-ant-api03-bobkey");
    h.stop();
  });

  test("an admin sets and takes back a grant; a person has no such command", async () => {
    const bob = getUserByName(forge.db, "bob")!;
    const h = boot("alice");
    await open(h, "Model grant");
    await h.type("bob");
    await h.press("enter");
    await h.type("12.5");
    await h.press("enter");
    expect(getModelGrant(forge.db, bob.id)?.usdPerMonth).toBe(12.5);
    await open(h, "Model grant");
    await h.type("bob");
    await h.press("enter");
    await h.type("none");
    await h.press("enter");
    expect(getModelGrant(forge.db, bob.id)).toBeUndefined();
    h.stop();

    const p = boot("bob");
    await p.ctrl("k");
    await p.type("Model grant");
    expect(p.text()).not.toContain("give an account dollars");
    p.stop();
  });

  test("an admin sets an account's ceilings in the terminal; a person has no such command", async () => {
    const bob = getUserByName(forge.db, "bob")!;
    const h = boot("alice");
    await open(h, "Model ceiling");
    await h.type("bob");
    await h.press("enter");
    await h.type("20 5");
    await h.press("enter");
    expect(getAccountCeiling(forge.db, bob.id)).toEqual({ dailyUsd: 20, perRunUsd: 5 });
    await open(h, "Model ceiling");
    await h.type("bob");
    await h.press("enter");
    expect(h.text()).toContain("now $20.00 a day, $5.00 a run");
    await h.press("enter"); // a stray Enter takes nothing back
    expect(getAccountCeiling(forge.db, bob.id)).toEqual({ dailyUsd: 20, perRunUsd: 5 });
    await h.type("none");
    await h.press("enter");
    expect(getAccountCeiling(forge.db, bob.id)).toBeUndefined();
    h.stop();

    const p = boot("bob");
    await p.ctrl("k");
    await p.type("Model ceiling");
    expect(p.text()).not.toContain("set an account's dollars");
    p.stop();
  });
});
