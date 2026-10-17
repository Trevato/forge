/** "Forges you sent" in the terminal palette (#2211). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { fitLines, forgeLines } from "../src/tui/screens/forges.ts";
import { runningWords, type ClientRow } from "../src/spawn/clients.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const row = (over: Partial<ClientRow>): ClientRow => ({
  name: "maria",
  url: "https://maria.test",
  for: "Maria's bakery",
  apps: [],
  sentAt: null,
  made: true,
  claimed: false,
  lastActivityAt: null,
  running: null,
  ...over,
});

describe("forges you sent in the terminal", () => {
  let dataDir: string;
  let forge: Forge;

  function boot(username: string | null) {
    const terminal = headlessTerminal(140, 32);
    const user = username === null ? undefined : getUserByName(forge.db, username)!;
    const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user };
    const { app } = createForgeApp(forge, identity, { terminal, exitHooks: false });
    app.start();
    const key = (k: string, ctrl = false) =>
      app.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    return {
      text: () => app.screen.toText(),
      stop: () => app.stop(),
      async palette() {
        key("k", true);
        for (const ch of "Forges you sent") key(ch);
        await settleApp(app);
        return app.screen.toText();
      },
      async enter() {
        key("enter");
        await settleApp(app);
      },
    };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-forges-"));
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

  test("an admin is offered the command and sees the empty line", async () => {
    const h = boot("alice");
    expect(await h.palette()).toContain("each forge sent");
    await h.enter();
    expect(h.text()).toContain("You have not sent a forge yet");
    h.stop();
  });

  test("a member and a guest are not offered it", async () => {
    for (const who of ["bob", null]) {
      const h = boot(who);
      expect(await h.palette()).not.toContain("each forge sent");
      h.stop();
    }
  });

  test("a row says who, the claim state and the apps note; never a link", () => {
    const up = { total: 3, running: 3, notRunning: [] };
    const down = { total: 2, running: 1, notRunning: [{ slug: "notes", why: "build failed" }] };
    expect(forgeLines([row({ running: up })])).toEqual([
      ["maria", "for Maria's bakery · Not claimed yet · 3 apps running"],
    ]);
    expect(forgeLines([row({ claimed: true, running: down, for: null })])).toEqual([
      ["maria", "Claimed · 1 app running · notes: build failed"],
    ]);
    expect(forgeLines([row({ claimed: null })])[0]![1]).toContain("Unknown");
    expect(forgeLines([row({ made: false })])[0]![1]).toContain("Still being made");
    expect(JSON.stringify(forgeLines([row({})]))).not.toContain("http");
    expect(runningWords(row({ running: { total: 0, running: 0, notRunning: [] } }))).toBeNull();
  });
});

test("a list taller than the card ends with how many are cut off", () => {
  const lines = Array.from({ length: 10 }, (_, i): [string, string] => [`f${i}`, "x"]);
  expect(fitLines(lines, 10)).toEqual(lines);
  const cut = fitLines(lines, 4);
  expect(cut).toHaveLength(4);
  expect(cut[3]![1]).toBe("+7 more (see /forges)");
});
