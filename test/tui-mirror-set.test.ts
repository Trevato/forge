/** The terminal's resilience screen seals and forgets the off-box mirror, as MCP `mirror_set` does, and never draws a key. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { mirrorSealedSet } from "../src/snapshot/mirror.ts";
import { startSnapshots, type SnapshotsHandle } from "../src/snapshot/service.ts";
import { dirStore } from "../src/snapshot/store.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp, settleUntil } from "./helpers/tui.ts";

quietLogs();

describe("mirror in the terminal", () => {
  let dataDir: string;
  let forge: Forge;
  let svc: SnapshotsHandle;
  const ACCESS = "AKIAEXAMPLEKEY";
  const SECRET = "s3cr3t-key-that-must-not-leak";
  const frames: string[] = [];

  function boot(username: string) {
    const terminal = headlessTerminal(140, 32);
    const user = getUserByName(forge.db, username)!;
    const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user };
    const { app } = createForgeApp(forge, identity, { terminal, exitHooks: false });
    app.start();
    const key = (k: string) => app.dispatch({ type: "key", key: k, ctrl: false, alt: false, shift: false });
    const snap = () => frames.push(app.screen.toText());
    return {
      text: () => app.screen.toText(),
      press: async (...keys: string[]) => {
        keys.forEach(key);
        await settleApp(app);
        snap();
      },
      ctrl: async (k: string) => {
        app.dispatch({ type: "key", key: k, ctrl: true, alt: false, shift: false });
        await settleApp(app);
      },
      type: async (t: string) => {
        for (const ch of t) key(ch);
        await settleApp(app);
        snap();
      },
      until: (what: string) => settleUntil(app, what, { timeoutMs: 4_000 }),
      stop: () => app.stop(),
    };
  }

  const open = async (h: ReturnType<typeof boot>) => {
    await h.ctrl("k");
    await h.type("Resilience");
    await h.until("each protection");
    await h.press("enter");
    await h.until("Mirror:");
  };
  const field = async (h: ReturnType<typeof boot>, value: string) => {
    await h.type(value);
    await h.press("enter");
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-mirror-"));
    forge = createApp({ dataDir, port: 0 });
    // A local directory stands in for the bucket: sealing starts a pass, and it never leaves the machine.
    const mirror = dirStore(join(dataDir, "mirror"));
    svc = startSnapshots(forge, dirStore(join(dataDir, "store")), {
      version: "t",
      nightly: false,
      mirror: () => (mirrorSealedSet(forge.db).length >= 4 ? mirror : undefined),
    });
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
    await svc.stop();
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("seal, read back without a key, keep a sealed key on a blank field, forget", async () => {
    const h = boot("alice");
    await open(h);
    expect(h.text()).toContain("Mirror: none.");
    expect(h.text()).toContain("m sets the mirror, f forgets it.");
    await h.press("m");
    await field(h, "http://s3.example.test");
    await field(h, "offbox-copy");
    await field(h, "");
    await field(h, ACCESS);
    await h.type(SECRET);
    expect(h.text()).not.toContain(SECRET);
    await h.press("enter");
    expect(mirrorSealedSet(forge.db).length).toBe(4);
    expect(h.text()).toContain("Mirror sealed");
    expect(h.text()).toContain("mirror"); // the place: the local directory
    expect(h.text()).not.toContain("Mirror: none.");

    // Blank everywhere but the bucket: the sealed keys stay.
    await h.press("m");
    await field(h, "");
    await field(h, "offbox-other");
    await field(h, "");
    await field(h, "");
    await field(h, "");
    expect(mirrorSealedSet(forge.db).length).toBe(4);
    expect(h.text()).toContain("Mirror sealed");

    // A refused field is named in the page's words, and nothing is sealed over it.
    await h.press("m");
    await field(h, "ftp://nope");
    await field(h, "");
    await field(h, "");
    await field(h, "");
    await field(h, "");
    expect(h.text()).toContain("The endpoint must be an http(s) URL");
    await h.press("esc");

    await h.press("f");
    await h.press("enter"); // the default is Cancel
    expect(mirrorSealedSet(forge.db).length).toBe(4);
    await h.press("f");
    await h.press("right", "enter");
    expect(mirrorSealedSet(forge.db)).toEqual([]);
    expect(h.text()).toContain("Mirror: none.");
    h.stop();

    for (const frame of frames) {
      expect(frame).not.toContain(SECRET);
      expect(frame).not.toContain(ACCESS);
    }
  });

  test("an admin who is not a person opens Resilience but is offered no M or F", async () => {
    const made = await createUser(forge.db, {
      origin: "seed", trusted: true, username: "robo", email: "robo@forge.local", password: "a-good-passphrase",
    });
    if (!made.ok) throw new Error(made.error);
    forge.db.query("UPDATE user SET is_agent = 1, is_admin = 1 WHERE username = 'robo'").run();
    expect(getUserByName(forge.db, "robo")).toMatchObject({ kind: "agent", isAdmin: true });
    const before = mirrorSealedSet(forge.db);
    const h = boot("robo");
    await open(h);
    expect(h.text()).not.toContain("m sets the mirror");
    await h.press("m");
    expect(h.text()).not.toContain("Mirror 1/5");
    await h.press("f");
    expect(h.text()).not.toContain("Forget the mirror?");
    expect(mirrorSealedSet(forge.db)).toEqual(before);
    h.stop();
  });

  test("a person who is not an admin is not offered Resilience", async () => {
    const h = boot("bob");
    await h.ctrl("k");
    await h.type("Resilience");
    await h.until("Resilience");
    expect(h.text()).not.toContain("each protection");
    h.stop();
  });
});
