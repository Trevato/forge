/**
 * Crew agents in the terminal (#7289): an admin who is not an agent lists the
 * agents with model, budget and brief, and changes or creates or removes one
 * after a plan and a confirm, through the crew actions (so the same refusals
 * apply, a bad value is refused before the confirm, and the change is put on
 * the bus); anyone else is not offered the screen.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { createAgentRow, getAgentByName } from "../src/core/agents.ts";
import { listEvents } from "../src/core/events.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("agents in the terminal", () => {
  let dataDir: string;
  let forge: Forge;

  function boot(username: string) {
    const terminal = headlessTerminal(140, 32);
    const user = getUserByName(forge.db, username)!;
    const { app } = createForgeApp(
      forge,
      { sshUsername: "t", remoteAddress: "127.0.0.1", user },
      { terminal, exitHooks: false },
    );
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
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-agents-"));
    forge = createApp({ dataDir, port: 0 });
    for (const username of ["alice", "bob", "carol", "bot1"]) {
      const made = await createUser(forge.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: username === "alice",
      });
      if (!made.ok) throw new Error(made.error);
      if (username === "bot1") createAgentRow(forge.db, { userId: made.value.id, model: "opus" });
    }
    forge.db.query("UPDATE user SET is_admin = 1, is_agent = 1 WHERE username = 'carol'").run();
  });
  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const open = async (h: ReturnType<typeof boot>) => {
    await h.ctrl("k");
    await h.type("Crew agents");
    await h.press("enter");
  };
  const clear = async (h: ReturnType<typeof boot>, n = 12) => {
    for (let i = 0; i < n; i++) await h.press("backspace");
  };

  test("lists each agent with model, budget and the first line of its brief", async () => {
    forge.db.query("UPDATE agent SET brief = 'Reviews pulls.\nSecond line.', budget_usd = 2 WHERE 1").run();
    const h = boot("alice");
    await open(h);
    expect(h.text()).toContain("bot1");
    expect(h.text()).toContain("opus");
    expect(h.text()).toContain("$2");
    expect(h.text()).toContain("Reviews pulls.");
    expect(h.text()).not.toContain("Second line.");
    h.stop();
  });

  test("a budget changes only after a confirm", async () => {
    const h = boot("alice");
    await open(h);
    await h.press("b");
    await clear(h);
    await h.type("5");
    await h.press("enter");
    expect(h.text()).toContain("$2 → $5");
    expect(getAgentByName(forge.db, "bot1")!.budgetUsd).toBe(2);
    await h.press("n");
    expect(getAgentByName(forge.db, "bot1")!.budgetUsd).toBe(2);
    await h.press("b");
    await clear(h);
    await h.type("5");
    await h.press("enter");
    await h.press("y");
    expect(getAgentByName(forge.db, "bot1")!.budgetUsd).toBe(5);
    expect(h.text()).toContain("bot1 saved.");
    expect(listEvents(forge.db, { kind: "agent.updated" }).length).toBe(1);
    h.stop();
  });

  test("a budget over the maximum, a negative and a non-number are refused before any confirm", async () => {
    for (const bad of ["100000", "-1", "abc"]) {
      const h = boot("alice");
      await open(h);
      await h.press("b");
      await clear(h);
      await h.type(bad);
      await h.press("enter");
      expect(h.text()).toContain("refused: invalid_budget");
      expect(h.text()).not.toContain("Change agent");
      expect(getAgentByName(forge.db, "bot1")!.budgetUsd).toBe(5);
      h.stop();
    }
  });

  test("a bad model is refused before the confirm", async () => {
    const h = boot("alice");
    await open(h);
    await h.press("m");
    await clear(h);
    await h.type("not a model");
    await h.press("enter");
    expect(h.text()).toContain("refused: invalid_model");
    expect(h.text()).not.toContain("Change agent");
    expect(getAgentByName(forge.db, "bot1")!.model).toBe("opus");
    h.stop();
  });

  test("a brief changes after a confirm", async () => {
    const h = boot("alice");
    await open(h);
    await h.press("B");
    await clear(h, 60);
    await h.type("Writes docs.");
    await h.press("enter");
    expect(h.text()).toContain("Writes docs.");
    expect(getAgentByName(forge.db, "bot1")!.brief).toContain("Reviews pulls.");
    await h.press("y");
    expect(getAgentByName(forge.db, "bot1")!.brief).toBe("Writes docs.");
    h.stop();
  });

  test("a duplicate username on create is refused", async () => {
    const h = boot("alice");
    await open(h);
    await h.press("n");
    await h.type("bot1");
    await h.press("enter");
    await h.press("enter");
    expect(h.text()).toContain("refused:");
    h.stop();
  });

  test("creates an agent by username then model, and removes it after a confirm", async () => {
    const h = boot("alice");
    await open(h);
    await h.press("n");
    await h.type("newbie");
    await h.press("enter");
    await h.type("haiku");
    await h.press("enter");
    expect(getAgentByName(forge.db, "newbie")!.model).toBe("haiku");
    expect(h.text()).toContain("newbie created.");
    await h.press("j", "d");
    expect(h.text()).toContain("cannot be undone");
    await h.press("n");
    expect(getAgentByName(forge.db, "newbie")).toBeDefined();
    expect(h.text()).toContain("newbie");
    await h.press("d", "y");
    expect(getAgentByName(forge.db, "newbie")).toBeUndefined();
    expect(h.text()).toContain("newbie removed.");
    h.stop();
  });

  test("roles change after a confirm and a bad one is refused before it", async () => {
    const h = boot("alice");
    await open(h);
    await h.press("r");
    await clear(h, 20);
    await h.type("planner, boss");
    await h.press("enter");
    expect(getAgentByName(forge.db, "bot1")!.roles).toEqual(["builder"]);
    await h.press("escape");
    await h.press("r");
    await clear(h, 20);
    await h.type("planner, reviewer");
    await h.press("enter");
    await h.press("y");
    expect(getAgentByName(forge.db, "bot1")!.roles).toEqual(["planner", "reviewer"]);
    h.stop();
  });

  test("a non-admin and an admin agent are never offered the screen", async () => {
    for (const who of ["bob", "carol"]) {
      const h = boot(who);
      await h.ctrl("k");
      await h.type("Crew agents");
      expect(h.text()).not.toContain("each agent's model");
      h.stop();
    }
  });
});
