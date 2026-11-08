/**
 * The terminal's Resilience dialog runs a restore drill with `r` after a y/n
 * (issue #8007, pull #8018), through `drillNow` — the Backups page's action — and says the
 * verdict in the page's words. The drill itself is stubbed: a real one
 * restores a snapshot and can take minutes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { drillNow } from "../src/actions/backups_now.ts";
import type { DrillResult } from "../src/snapshot/drill.ts";
import { startSnapshots, type SnapshotsHandle } from "../src/snapshot/service.ts";
import { dirStore } from "../src/snapshot/store.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const GREEN: DrillResult = {
  at: new Date(0).toISOString(),
  snapshotId: "s1",
  ms: 1,
  counts: { repositories: 0, issues: 0, users: 2, pulls: 0, apps: 0 },
  health: "ok",
  verdict: "green",
  failedStep: null,
  phases: [],
  budgetMs: 1000,
  reason: null,
};

describe("a restore drill from the terminal's Resilience dialog", () => {
  let dataDir: string;
  let forge: Forge;
  let svc: SnapshotsHandle;
  let drills = 0;
  let verdict: DrillResult = GREEN;

  function boot(username: string) {
    const terminal = headlessTerminal(140, 40);
    const user = getUserByName(forge.db, username)!;
    const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user };
    const { app } = createForgeApp(forge, identity, { terminal, exitHooks: false });
    app.start();
    const send = (k: string, ctrl = false) => app.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    const press = async (...keys: string[]) => {
      for (const k of keys) send(k);
      await settleApp(app);
    };
    const open = async () => {
      send("k", true);
      await settleApp(app);
      for (const ch of "Resilience") send(ch);
      await settleApp(app);
      const listed = app.screen.toText();
      await press("enter");
      return listed;
    };
    const waitFor = async (text: string) => {
      for (let i = 0; i < 100 && !app.screen.toText().includes(text); i++) {
        await Bun.sleep(20);
        await press();
      }
      if (!app.screen.toText().includes(text)) throw new Error(`never came: still waiting while !app.screen.toText().includes(text)`);
    };
    return { text: () => app.screen.toText(), press, open, waitFor, stop: () => app.stop() };
  }

  const start = (store: boolean) =>
    startSnapshots(forge, store ? dirStore(join(dataDir, "store")) : () => undefined, {
      version: "t",
      nightly: false,
      drill: async () => {
        drills++;
        return verdict;
      },
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-resilience-drill-"));
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
    svc = start(true);
  }, 30_000);

  afterAll(async () => {
    await svc.stop();
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an admin is offered r, and r then y says the drill restored green", async () => {
    const h = boot("alice");
    await h.open();
    expect(h.text()).toContain("r  run a restore drill");
    await h.press("r");
    expect(h.text()).toContain("run a restore drill now? y/n");
    expect(h.text()).not.toContain("r  run a restore drill");
    const before = drills;
    await h.press("y");
    await h.waitFor("The drill restored green.");
    expect(h.text()).toContain("The drill restored green.");
    expect(drills).toBe(before + 1);
    h.stop();
  });

  test("a red drill names the step it failed at", async () => {
    verdict = { ...GREEN, verdict: "red", failedStep: "restore", health: "unreached" };
    const h = boot("alice");
    await h.open();
    await h.press("r", "y");
    await h.waitFor("The drill failed at restore.");
    expect(h.text()).toContain("The drill failed at restore.");
    verdict = GREEN;
    h.stop();
  });

  test("r then n, or esc, runs nothing", async () => {
    const h = boot("alice");
    await h.open();
    const before = drills;
    await h.press("r", "n");
    expect(h.text()).not.toContain("run a restore drill now? y/n");
    await h.press("r", "esc");
    expect(h.text()).not.toContain("run a restore drill now? y/n");
    expect(h.text()).toContain("Snapshots, newest first:");
    await Bun.sleep(20);
    expect(drills).toBe(before);
    h.stop();
  });

  test("a non-admin is not offered the dialog, and drillNow refuses them", async () => {
    const h = boot("bob");
    expect(await h.open()).not.toContain("each protection green, red or untested");
    expect(h.text()).not.toContain("r  run a restore drill");
    h.stop();
    const before = drills;
    const ran = await drillNow(forge, getUserByName(forge.db, "bob")!);
    expect(ran.ok).toBe(false);
    if (!ran.ok) expect(ran.error.code).toBe("not_found");
    expect(drills).toBe(before);
  });

  test("a forge with no store says it has no snapshots to drill", async () => {
    await svc.stop();
    svc = start(false);
    const h = boot("alice");
    await h.open();
    await h.press("r", "y");
    await h.waitFor("no snapshots to drill");
    expect(h.text()).toContain("This forge has no snapshots to drill.");
    const ran = await drillNow(forge, getUserByName(forge.db, "alice")!);
    expect(ran.ok).toBe(false);
    if (!ran.ok) expect(ran.error.code).toBe("no_store");
    h.stop();
  });
});
