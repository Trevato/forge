/**
 * The terminal's Resilience dialog takes a snapshot with `n` and brings the
 * mirror level with `l`, each after a y/n (#7318), through the actions MCP
 * `snapshot_now` and `mirror_now` use; a non-admin is refused by them.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { mirrorNow, snapshotNow } from "../src/actions/backups_now.ts";
import { startSnapshots, type SnapshotsHandle } from "../src/snapshot/service.ts";
import { dirStore, type Store } from "../src/snapshot/store.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("snapshot and mirror from the terminal's Resilience dialog", () => {
  let dataDir: string;
  let forge: Forge;
  let svc: SnapshotsHandle;

  function boot(username: string) {
    const terminal = headlessTerminal(140, 40);
    const user = getUserByName(forge.db, username)!;
    const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user };
    const { app } = createForgeApp(forge, identity, { terminal, exitHooks: false });
    app.start();
    const send = (k: string, ctrl = false) =>
      app.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
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
    // Keys without waiting for what they start: to see a screen mid-action.
    const sendOnly = (...keys: string[]) => {
      for (const k of keys) send(k);
      app.frame();
    };
    return { text: () => app.screen.toText(), press, sendOnly, open, stop: () => app.stop() };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-resilience-now-"));
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
    svc = startSnapshots(forge, dirStore(join(dataDir, "store")), { version: "t", nightly: false });
  }, 30_000);

  afterAll(async () => {
    await svc.stop();
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an admin is offered n and l, and n then y adds a snapshot shown on top", async () => {
    const h = boot("alice");
    await h.open();
    expect(h.text()).toContain("Snapshots, newest first:");
    expect(h.text()).toContain("none kept");
    expect(h.text()).toContain("n  take a snapshot now");
    expect(h.text()).toContain("l  bring the mirror level now");

    await h.press("n");
    expect(h.text()).toContain("take a snapshot now? y/n");
    await h.press("x");
    expect(h.text()).not.toContain("take a snapshot now? y/n");
    expect(await svc.list()).toEqual([]);

    await h.press("n", "y");
    for (let i = 0; i < 100 && !h.text().includes(" taken: "); i++) {
      await Bun.sleep(20);
      await h.press();
    }
    if (!h.text().includes(" taken: ")) throw new Error(`never came: still waiting while !h.text().includes(" taken: ")`);
    const kept = await svc.list();
    expect(kept.length).toBe(1);
    const lines = h.text().split("\n");
    const head = lines.findIndex((l) => l.includes("Snapshots, newest first:"));
    expect(lines[head + 1]).toContain(kept[0]!.name);
    expect(h.text()).toContain(`Snapshot ${kept[0]!.name} taken: `);
    h.stop();
  });

  test("l then y says in words that there is no mirror, and draws no secret", async () => {
    const h = boot("alice");
    await h.open();
    await h.press("l");
    expect(h.text()).toContain("bring the mirror level now? y/n");
    await h.press("y");
    for (let i = 0; i < 100 && !h.text().includes("no mirror"); i++) {
      await Bun.sleep(20);
      await h.press();
    }
    expect(h.text()).toContain("This forge has no mirror to bring level.");
    expect(h.text()).not.toContain("SNAPSHOT_MIRROR_S3");
    h.stop();
  });

  test("a non-admin has no Resilience command, and both actions refuse them", async () => {
    const h = boot("bob");
    expect(await h.open()).not.toContain("each protection green, red or untested");
    expect(h.text()).not.toContain("Snapshots, newest first:");
    h.stop();
    const bob = getUserByName(forge.db, "bob")!;
    const before = (await svc.list()).length;
    const taken = await snapshotNow(forge, bob);
    expect(taken.ok).toBe(false);
    if (!taken.ok) expect(taken.error.code).toBe("not_found");
    expect((await mirrorNow(forge, bob)).ok).toBe(false);
    expect((await svc.list()).length).toBe(before);
  });

  test("n then y pressed twice while the first runs takes one snapshot, and the keys leave the footer", async () => {
    const h = boot("alice");
    await h.open();
    // Two snapshots in one second share a name, so count the asks, not the store.
    let asked = 0;
    const take = svc.now;
    (svc as { now: SnapshotsHandle["now"] }).now = () => {
      asked++;
      return take();
    };
    h.sendOnly("n", "y", "n", "y", "l", "y");
    expect(h.text()).toContain("Taking a snapshot…");
    expect(h.text()).not.toContain("take a snapshot now? y/n");
    expect(h.text()).not.toContain("n  take a snapshot now");
    for (let i = 0; i < 100 && !h.text().includes(" taken: "); i++) {
      await Bun.sleep(20);
      await h.press();
    }
    if (!h.text().includes(" taken: ")) throw new Error(`never came: still waiting while !h.text().includes(" taken: ")`);
    (svc as { now: SnapshotsHandle["now"] }).now = take;
    expect(asked).toBe(1);
    expect(h.text()).toContain("n  take a snapshot now");
    h.stop();
  });

  test("a store that cannot be listed says so, never none kept", async () => {
    await svc.stop();
    const inner = dirStore(join(dataDir, "broken"));
    const broken: Store = {
      ...inner,
      list: async () => {
        throw new Error("list refused");
      },
      names: async () => {
        throw new Error("names refused");
      },
    };
    svc = startSnapshots(forge, broken, { version: "t", nightly: false });
    const h = boot("alice");
    await h.open();
    expect(h.text()).toContain("the snapshots could not be read");
    expect(h.text()).not.toContain("none kept");
    expect(h.text()).not.toContain("list refused");
    expect(h.text()).not.toContain("names refused");
    h.stop();
  });
});
