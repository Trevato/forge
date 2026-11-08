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
  reach: null,
  attention: null,
  spendTodayUsd: null,
  ceilingUsd: null,
  size: "small",
  use: { kind: "shared" },
  lastHeartbeatAt: null,
  nextStep: { key: "unreported", words: "has not reported yet", lastTellAt: null },
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

  test("a forge running, not reachable says so, with each address and its result", () => {
    const reach = {
      name: "maria", at: "2026-11-02T00:00:00.000Z", ok: false, since: "2026-11-02T00:00:00.000Z", alarmed: true,
      proofs: [
        { label: "home", url: "https://maria--forge.test/api/v1/forge", ok: true, status: 200, says: "answered 200" },
        { label: "deal", url: "https://deal--maria--forge.test/", ok: false, status: 404, says: "answered 404, not by the app" },
      ],
    };
    const lines = forgeLines([row({ reach })]);
    expect(lines[0]![1]).toContain("Running, not reachable: deal answered 404, not by the app");
    expect(lines.slice(1).map(([, t]) => t.trim())).toEqual([
      "reachable maria--forge.test/api/v1/forge: answered 200",
      "NOT REACHABLE deal--maria--forge.test/: answered 404, not by the app",
    ]);
  });

  test("a row carries the crew's spend today, and says when the ceiling is reached", () => {
    expect(forgeLines([row({ spendTodayUsd: 10, ceilingUsd: 10 })])[0]![1]).toContain("ceiling reached");
    expect(forgeLines([row({ spendTodayUsd: 3.2, ceilingUsd: 10 })])[0]![1]).toContain("$3.20 of $10 today");
    expect(forgeLines([row({})])[0]![1]).not.toContain("today");
  });

  test("a row says its size and use: shared when hosted, X of Y in a cell", () => {
    const hosted = forgeLines([row({ size: "medium" })])[0]![1];
    expect(hosted).toContain("medium · shared");
    const cell = row({
      size: "small",
      use: { kind: "cell", limits: { cpu: 1, memoryMiB: 512, diskMiB: 2048 }, memoryMiB: 310, cores: 0.4, diskMiB: 100 },
      lastHeartbeatAt: new Date().toISOString(),
    });
    const line = forgeLines([cell])[0]![1];
    expect(line).toContain("memory 310 MiB of 512 MiB");
    expect(line).toContain("cpu 0.4 of 1 core");
    expect(line).toContain("disk 100 MiB of 2 GiB");
    expect(line).toContain("heartbeat just now");
    const idle = row({ size: "small", use: { kind: "idle", limits: { cpu: 1, memoryMiB: 512, diskMiB: 2048 } } });
    expect(forgeLines([idle])[0]![1]).toContain("memory not running");
  });

  test("a row says who, the claim state and the apps note; never a link", () => {
    const up = { total: 3, running: 3, notRunning: [] };
    const down = { total: 2, running: 1, notRunning: [{ slug: "notes", why: "build failed" }] };
    expect(forgeLines([row({ running: up })])).toEqual([
      ["maria", "for Maria's bakery · Not claimed yet · 3 apps running · has not reported yet · small · shared · no heartbeat yet"],
    ]);
    expect(forgeLines([row({ claimed: true, running: down, for: null })])).toEqual([
      ["maria", "Claimed · 1 app running · notes: build failed · has not reported yet · small · shared · no heartbeat yet"],
    ]);
    expect(forgeLines([row({ claimed: null })])[0]![1]).toContain("Unknown");
    expect(forgeLines([row({ made: false })])[0]![1]).toContain("Still being made");
    expect(forgeLines([row({ attention: "down", claimed: true, for: null })])).toEqual([
      ["maria", "App down · Claimed · has not reported yet · small · shared · no heartbeat yet"],
    ]);
    expect(forgeLines([row({})])[0]![1]).not.toMatch(/Not reporting|App down|Unclaimed/);
    expect(forgeLines([row({ nextStep: { key: "tell", words: "no tell yet", lastTellAt: null } })])[0]![1]).toContain("no tell yet");
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
