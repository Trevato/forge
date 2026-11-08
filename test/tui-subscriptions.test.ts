/**
 * The crew's subscriptions in the terminal (#7244): list, wake, budget, with
 * the gate of MCP `subscriptions`; no frame carries a token.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import {
  addSubscription,
  budgetsOf,
  getSubscriptionByName,
  lockBudget,
  restSubscription,
} from "../src/core/subscriptions.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp, settleUntil } from "./helpers/tui.ts";

quietLogs();

const TOKEN_A = "sk-ant-oat01-secretalpha";
const TOKEN_B = "sk-ant-api03-secretbeta";

describe("crew subscriptions in the terminal", () => {
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
      until: (what: string) => settleUntil(app, what, { timeoutMs: 4_000 }),
      stop: () => app.stop(),
    };
  }

  const openScreen = async (h: ReturnType<typeof boot>) => {
    await h.ctrl("k");
    await h.type("Crew subscriptions");
    await h.until("each account's budget");
    await h.press("enter");
    await h.until("w wakes");
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-subs-"));
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
    for (const [name, token] of [["alpha", TOKEN_A], ["beta", TOKEN_B]] as const) {
      const made = addSubscription(forge.db, dataDir, { name, token });
      if (!made.ok) throw new Error(made.error);
    }
    const alpha = getSubscriptionByName(forge.db, "alpha")!;
    restSubscription(forge.db, alpha.id, new Date(Date.now() + 3_600_000).toISOString(), "limit");
  });
  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("lists two, wakes the resting one, says so for an awake one, never shows a token", async () => {
    const h = boot("alice");
    await openScreen(h);
    expect(h.text()).toContain("alpha");
    expect(h.text()).toContain("beta");
    expect(h.text()).toContain("resting until");
    expect(h.text()).not.toContain("secretalpha");
    expect(h.text()).not.toContain("secretbeta");
    await h.press("w");
    await h.until("alpha: in use again.");
    expect(getSubscriptionByName(forge.db, "alpha")!.restingUntil).toBeNull();
    await h.press("w");
    await h.until("alpha is awake already.");
    h.stop();
  });

  test("sets a budget, refuses a bad one in words", async () => {
    const beta = getSubscriptionByName(forge.db, "beta")!;
    const h = boot("alice");
    await openScreen(h);
    await h.press("j", "b");
    await h.until("Budget for beta");
    await h.type("25");
    await h.press("enter");
    expect(budgetsOf(forge.db).get(beta.id)!.budgetUsd).toBe(25);
    await h.until("Budget set: $25.00 in all.");
    await h.press("b");
    await h.until("Budget for beta");
    await h.type("-5");
    await h.press("enter");
    await h.until("Dollars, like 25");
    expect(budgetsOf(forge.db).get(beta.id)!.budgetUsd).toBe(25);
    await h.press("esc");
    await h.press("b");
    await h.type("99999999");
    await h.press("enter");
    await h.until("A budget is dollars from 1 to");
    expect(budgetsOf(forge.db).get(beta.id)!.budgetUsd).toBe(25);
    expect(h.text()).not.toContain("secretbeta");
    h.stop();
  });

  test("none clears an unlocked budget", async () => {
    const beta = getSubscriptionByName(forge.db, "beta")!;
    const h = boot("alice");
    await openScreen(h);
    await h.press("j", "b");
    await h.until("Budget for beta");
    await h.type("none");
    await h.press("enter");
    await h.until("No budget");
    expect(budgetsOf(forge.db).get(beta.id)!.budgetUsd).toBeNull();
    h.stop();
  });

  test("a locked budget set by whoever made this forge", async () => {
    const alpha = getSubscriptionByName(forge.db, "alpha")!;
    lockBudget(forge.db, alpha.id, 10);
    const h = boot("alice");
    await openScreen(h);
    const attempt = async (v: string) => {
      await h.press("b");
      await h.until("Budget for alpha");
      await h.type(v);
      await h.press("enter");
    };
    await attempt("20");
    await h.until("set by whoever made this forge");
    await h.press("esc");
    await attempt("none");
    await h.until("set by whoever made this forge");
    await h.press("esc");
    expect(budgetsOf(forge.db).get(alpha.id)!.budgetUsd).toBe(10);
    await attempt("5");
    await h.until("Budget set: $5.00 in all.");
    expect(budgetsOf(forge.db).get(alpha.id)!.budgetUsd).toBe(5);
    h.stop();
  });

  test("someone MCP refuses is never offered the screen", async () => {
    const h = boot("bob");
    await h.ctrl("k");
    await h.type("Crew subscriptions");
    await h.until("Crew subscriptions"); // the palette has drawn the query
    expect(h.text()).not.toContain("each account's budget");
    h.stop();
  });
});
