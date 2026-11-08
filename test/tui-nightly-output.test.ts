/**
 * The terminal's door to a nightly run's output (#9019): `o` in the
 * Resilience dialog, a forge admin's as /resilience/nightly/<job> is, shows
 * each job's line and the tail of its newest output.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { startOutput } from "../src/nightly/output.ts";
import { writeLast } from "../src/nightly/stamps.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { resilienceScreen, OUTPUT_TAIL } from "../src/tui/screens/resilience.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("a nightly run's output in the terminal", () => {
  let dataDir: string;
  let forge: Forge;

  function boot(username: string) {
    const terminal = headlessTerminal(140, 48);
    const user = getUserByName(forge.db, username)!;
    const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user };
    const { app, session } = createForgeApp(forge, identity, { terminal, exitHooks: false });
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
      await press("enter");
    };
    return { app, session, text: () => app.screen.toText(), press, open, stop: () => app.stop() };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-nightly-output-"));
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
    const out = startOutput(dataDir, "outside-gate");
    out.write("an early line the tail leaves out");
    for (let i = 0; i < OUTPUT_TAIL - 1; i++) out.write(`green: test/f${i}.test.ts`);
    out.write("  filed #12 for test/x.test.ts");
    await out.end();
    writeLast(dataDir, "outside-gate", {
      slot: Date.parse("2026-11-03T03:47:00Z"),
      startedAt: Date.parse("2026-11-03T03:47:01Z"),
      finishedAt: Date.parse("2026-11-03T04:02:00Z"),
      says: "every step finished; filed #12.",
    });
  });

  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an admin presses o and reads each job's line and the tail of its output", async () => {
    const h = boot("alice");
    await h.open();
    expect(h.text()).toContain("o  nightly output");
    await h.press("o");
    const text = h.text();
    expect(text).toContain("Nightly output");
    expect(text).toContain("every step finished; filed #12.");
    expect(text).toContain("filed #12 for test/x.test.ts");
    expect(text).toContain("green: test/f0.test.ts");
    expect(text).not.toContain("an early line the tail leaves out");
    expect(text).toContain("no output here yet: it has not run on this forge");
    await h.press("esc");
    expect(h.text()).not.toContain("Nightly output");
    expect(h.text()).toContain("Snapshots, newest first:");
    h.stop();
  });

  test("anyone but an admin is not offered o, and o opens nothing for them", async () => {
    const h = boot("bob");
    const pushed: string[] = [];
    const ctx = { ...h.app.ctx, push: (s: { title: string }) => void pushed.push(s.title), invalidate: () => undefined };
    const screen = resilienceScreen(h.session, ctx as never);
    expect(screen.keys.some((k) => k.help === "nightly output")).toBe(false);
    screen.key({ type: "key", key: "o", ctrl: false, alt: false, shift: false });
    expect(pushed).toEqual([]);
    h.stop();
  });
});
