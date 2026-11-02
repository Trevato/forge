/**
 * An organization's default subscription grants in the terminal (#8143, pull #8201): the
 * `org grants` screen saves a toggle at the organization's scope, a repository
 * without its own grant then reads it (through the usage read), and anyone but
 * an admin of the organization who is a forge admin, or any agent's session,
 * is offered nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { readUsage } from "../src/actions/usage.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { createAgentRow } from "../src/core/agents.ts";
import { addTeamMember, createOrg, listTeams } from "../src/core/orgs.ts";
import { addSubscription, EVERYONE, listGrants } from "../src/core/subscriptions.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("organization grants in the terminal", () => {
  let dataDir: string;
  let forge: Forge;
  let orgId: string;
  let starterId: string;

  function boot(username: string) {
    const terminal = headlessTerminal(140, 32);
    const user = getUserByName(forge.db, username)!;
    const { app } = createForgeApp(
      forge,
      { sshUsername: "t", remoteAddress: "127.0.0.1", user },
      { terminal, exitHooks: false },
    );
    app.start();
    const key = (k: string, ctrl = false) => app.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    return {
      text: () => app.screen.toText(),
      press: async (...keys: string[]) => {
        keys.forEach((k) => key(k));
        await settleApp(app);
      },
      ctrl: async (k: string) => {
        key(k, true);
        await settleApp(app);
      },
      type: async (t: string) => {
        for (const ch of t) key(ch);
        await settleApp(app);
      },
      stop: () => app.stop(),
    };
  }

  const palette = async (h: ReturnType<typeof boot>) => {
    await h.ctrl("k");
    await h.type("org grants");
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-org-grants-"));
    forge = createApp({ dataDir, port: 0 });
    for (const username of ["rooty", "olive", "carol", "bot1"]) {
      const made = await createUser(forge.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: username === "rooty",
      });
      if (!made.ok) throw new Error(made.error);
      if (username === "bot1") createAgentRow(forge.db, { userId: made.value.id, model: "opus" });
    }
    forge.db.query("UPDATE user SET is_admin = 1, is_agent = 1 WHERE username = 'carol'").run();
    const id = (n: string) => getUserByName(forge.db, n)!.id;
    const org = createOrg(forge.db, "acme", id("rooty"));
    if (!org.ok) throw new Error(org.error);
    orgId = org.value.id;
    const owners = listTeams(forge.db, orgId).find((t) => t.name === "Owners")!;
    addTeamMember(forge.db, owners, id("olive"));
    addTeamMember(forge.db, owners, id("carol"));
    const sub = addSubscription(forge.db, dataDir, { name: "starter", token: "sk-ant-oat01-secretstarter" });
    if (!sub.ok) throw new Error(sub.error);
    starterId = sub.value.id;
  });
  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a toggle is saved at the organization's scope and a repository without its own grant reads it", async () => {
    const rooty = getUserByName(forge.db, "rooty")!;
    const repo = await createRepo(forge, rooty, { name: "wares", owner: "acme" });
    if (!repo.ok) throw new Error(String(repo.error));
    const standing = () => {
      const usage = readUsage(forge, rooty, repo.value, 7);
      if (!usage.ok) throw new Error("usage");
      return usage.value.standing.map((s) => s.subscription);
    };
    expect(standing()).not.toContain("starter");

    const h = boot("rooty");
    await palette(h);
    await h.press("enter");
    expect(h.text()).toContain("acme");
    await h.press("enter");
    const screen = h.text();
    expect(screen).toContain("everyone");
    expect(screen).toContain("@bot1");
    expect(screen).toContain("[ ] starter");
    expect(screen).not.toContain("secretstarter");
    await h.press(" ");
    expect(h.text()).toContain("Saved. Every repository here without a grant of its own follows it.");
    expect(h.text()).toContain("[x] starter");
    expect(listGrants(forge.db, orgId)).toEqual([{ scopeId: orgId, agentId: EVERYONE, subscriptionId: starterId }]);
    expect(standing()).toContain("starter");

    await h.press(" ");
    expect(listGrants(forge.db, orgId)).toEqual([]);
    h.stop();
  });

  test("a row other than everyone is saved on its own", async () => {
    const h = boot("rooty");
    await palette(h);
    await h.press("enter", "enter", "j", " ");
    const bot = getUserByName(forge.db, "bot1")!;
    expect(listGrants(forge.db, orgId)).toEqual([{ scopeId: orgId, agentId: bot.id, subscriptionId: starterId }]);
    await h.press(" ");
    h.stop();
  });

  test("an org admin who is not a forge admin, and an agent's session, are offered nothing", async () => {
    for (const name of ["olive", "carol", "bot1"]) {
      const h = boot(name);
      await palette(h);
      await h.press("enter");
      expect(h.text()).not.toContain("Org grants");
      h.stop();
    }
    expect(listGrants(forge.db, orgId)).toEqual([]);
  });

  test("an admin who loses admin after the screen opens writes nothing", async () => {
    const h = boot("rooty");
    await palette(h);
    await h.press("enter", "enter");
    forge.db.query("UPDATE user SET is_admin = 0 WHERE username = 'rooty'").run();
    await h.press(" ");
    expect(h.text()).toContain("Only an admin of this organization");
    expect(listGrants(forge.db, orgId)).toEqual([]);
    forge.db.query("UPDATE user SET is_admin = 1 WHERE username = 'rooty'").run();
    h.stop();
  });

  test("with no subscription the screen says so and h, l and space do nothing", async () => {
    forge.db.query("DELETE FROM subscription").run();
    const h = boot("rooty");
    await palette(h);
    await h.press("enter", "enter");
    expect(h.text()).toContain("No subscription yet.");
    await h.press("l", "l", "h", " ");
    expect(h.text()).toContain("No subscription yet.");
    expect(listGrants(forge.db, orgId)).toEqual([]);
    h.stop();
  });
});
