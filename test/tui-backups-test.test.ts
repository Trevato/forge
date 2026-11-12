/**
 * The terminal's resilience screen tests where snapshots go with `t`, as MCP
 * `backups_test` does: reached or why not, in the page's words, never a key.
 * Bun's S3 client is stood in for, as the MCP test does, so nothing leaves
 * the machine; Bun's own S3 wire is not what this pins.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { forgetDestination, saveDestination } from "../src/actions/destination.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp, settleUntil } from "./helpers/tui.ts";

quietLogs();

const ACCESS = "AKIAEXAMPLEKEY";
const SECRET = "s3cr3t-key-that-must-not-leak";
const ENV = ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_REGION"];

describe("testing where snapshots go, in the terminal", () => {
  let dataDir: string;
  let forge: Forge;
  const realS3 = Bun.S3Client;
  const savedEnv: Record<string, string | undefined> = {};
  const frames: string[] = [];
  const realSleep = Bun.sleep;
  const booted: { stop: () => void }[] = [];
  let calls = 0;
  let answer: (v: unknown) => void = () => {};

  const fakeS3 = (list: () => Promise<unknown>) => {
    (Bun as any).S3Client = class {
      async list() {
        calls++;
        return list();
      }
    };
  };

  // The store's retries wait 0.5 s, 1 s, 2 s, 4 s between five attempts; here they wait no time.
  const fastRetries = () => {
    (Bun as any).sleep = (ms: unknown, ...rest: unknown[]) =>
      typeof ms === "number" && ms >= 500 ? Promise.resolve() : (realSleep as any)(ms, ...rest);
  };

  function boot(username: string) {
    const terminal = headlessTerminal(140, 32);
    const user = getUserByName(forge.db, username)!;
    const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user };
    const { app, session } = createForgeApp(forge, identity, { terminal, exitHooks: false });
    app.start();
    const key = (k: string) => app.dispatch({ type: "key", key: k, ctrl: false, alt: false, shift: false });
    const snap = () => frames.push(app.screen.toText());
    const handle = {
      session,
      text: () => app.screen.toText(),
      // A key and one painted frame, without waiting for the work it started.
      tap: async (k: string) => {
        key(k);
        for (let i = 0; i < 5; i++) await Bun.sleep(0);
        app.frame();
        snap();
      },
      press: async (...keys: string[]) => {
        keys.forEach(key);
        await settleApp(app, { timeoutMs: 15_000 });
        snap();
      },
      ctrl: async (k: string) => {
        app.dispatch({ type: "key", key: k, ctrl: true, alt: false, shift: false });
        await settleApp(app);
      },
      type: async (t: string) => {
        for (const ch of t) key(ch);
        await settleApp(app);
      },
      until: async (what: string, timeoutMs = 4_000) => {
        await settleUntil(app, what, { timeoutMs });
        snap();
      },
      stop: () => app.stop(),
    };
    booted.push(handle);
    return handle;
  }

  const open = async (h: ReturnType<typeof boot>) => {
    await h.ctrl("k");
    await h.type("Resilience");
    await h.until("each protection");
    await h.press("enter");
    await h.until("Mirror:");
  };

  const seal = () => {
    const alice = getUserByName(forge.db, "alice")!;
    const saved = saveDestination(forge, alice, {
      endpoint: "http://s3.example.test",
      bucket: "offbox-snaps",
      region: "",
      accessKey: ACCESS,
      secretKey: SECRET,
    });
    if (!saved.ok) throw new Error(saved.error);
  };

  beforeAll(async () => {
    for (const name of ENV) {
      savedEnv[name] = process.env[name];
      delete process.env[name];
    }
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-backups-test-"));
    forge = createApp({ dataDir, port: 0 });
    for (const [username, adminIfFirst] of [["alice", true], ["bob", false], ["robo", false]] as const) {
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
    forge.db.query("UPDATE user SET is_agent = 1, is_admin = 1 WHERE username = 'robo'").run();
  });

  afterAll(async () => {
    (Bun as any).S3Client = realS3;
    for (const name of ENV) if (savedEnv[name] !== undefined) process.env[name] = savedEnv[name];
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  // Whatever a test did or failed to do, the next one starts with the real client, nobody waiting, and no frame carrying a key.
  afterEach(() => {
    (Bun as any).S3Client = realS3;
    (Bun as any).sleep = realSleep;
    answer({ contents: [], isTruncated: false });
    answer = () => {};
    for (const h of booted.splice(0)) h.stop();
    const seen = frames.splice(0);
    for (const frame of seen) {
      expect(frame).not.toContain(SECRET);
      expect(frame).not.toContain(ACCESS);
    }
  });

  test("with no destination set it says so and calls nobody", async () => {
    forgetDestination(forge, getUserByName(forge.db, "alice")!);
    calls = 0;
    fakeS3(async () => ({ contents: [], isTruncated: false }));
    const h = boot("alice");
    await open(h);
    expect(h.text()).toContain("t tests where snapshots go");
    await h.press("t");
    await h.until("no S3 destination to test");
    expect(calls).toBe(0);
  });

  test("a reachable store reads reached", async () => {
    seal();
    fakeS3(async () => ({ contents: [{ key: "a.tar" }], isTruncated: false }));
    const h = boot("alice");
    await open(h);
    await h.press("t");
    await h.until("Reached ");
    expect(h.text()).toContain("1 object listed.");
  });

  test("an unreachable store reads its reason, with no key in it", async () => {
    seal();
    fastRetries();
    fakeS3(async () => {
      throw new Error(`connection refused for ${ACCESS} using ${SECRET}`);
    });
    const h = boot("alice");
    await open(h);
    await h.press("t");
    await h.until("Could not list ");
    expect(h.text()).toContain("connection refused");
  });

  test("while a test is pending the dialog says so, and a second t does not start another", async () => {
    seal();
    calls = 0;
    fakeS3(() => new Promise((resolve) => (answer = resolve)));
    const h = boot("alice");
    await open(h);
    await h.tap("t");
    expect(h.text()).toContain("Testing where snapshots go…");
    await h.tap("t");
    expect(calls).toBe(1);
    answer({ contents: [], isTruncated: false });
    await h.until("Reached ");
    expect(h.text()).toContain("0 objects listed.");
    expect(calls).toBe(1);
  });

  test("an admin demoted while the screen is open is no longer answered by t, and nothing is called", async () => {
    seal();
    calls = 0;
    fakeS3(async () => ({ contents: [], isTruncated: false }));
    const h = boot("alice");
    await open(h);
    forge.db.query("UPDATE user SET is_admin = 0 WHERE username = 'alice'").run();
    try {
      h.session.refresh();
      await h.press("t");
      expect(h.text()).not.toContain("Testing where snapshots go");
      expect(calls).toBe(0);
    } finally {
      forge.db.query("UPDATE user SET is_admin = 1 WHERE username = 'alice'").run();
    }
  });

  test("an admin who is not a person, and a non-admin, are not offered t", async () => {
    calls = 0;
    fakeS3(async () => ({ contents: [], isTruncated: false }));
    const robo = boot("robo");
    await open(robo);
    expect(robo.text()).not.toContain("t tests where snapshots go");
    await robo.press("t");
    expect(robo.text()).not.toContain("Testing where snapshots go");
    expect(calls).toBe(0);

    const bob = boot("bob");
    await bob.ctrl("k");
    await bob.type("Resilience");
    await bob.until("Resilience");
    expect(bob.text()).not.toContain("each protection");
  });
});
