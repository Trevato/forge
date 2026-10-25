/**
 * The terminal's new-forge screen offers the web form's three sizes (#5681),
 * and the chosen one reaches the plan the door makes.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser, type User } from "../src/core/users.ts";
import { usePlacement, useProbe } from "../src/spawn/door.ts";
import { hostedPlacement } from "../src/spawn/placement.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { newForgeScreen } from "../src/tui/screens/newforge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let app: App;
let admin: User;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-newforge-size-"));
  app = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
  const r = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", isAdmin: true,
  });
  if (!r.ok) throw new Error(r.error);
  admin = r.value;
  useProbe(app, () => async () => true);
  usePlacement(app, hostedPlacement({ host: "forge.test" }));
});
afterAll(async () => {
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

const TO_SIZE = "\t".repeat(9); // name … follow mode, then Size

async function plan(keys: string): Promise<{ screen: string; size: unknown }> {
  const terminal = headlessTerminal(120, 40);
  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: "alice", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user: admin },
    { terminal, exitHooks: false },
  );
  tui.start();
  tui.ctx.push(newForgeScreen(session, tui.ctx));
  try {
    await settleApp(tui);
    terminal.feed(keys + "\x10");
    await settleApp(tui);
    const screen = tui.screen.toText();
    const m = /Size: (\w+)\./.exec(screen);
    return { screen, size: m?.[1] };
  } finally {
    tui.stop?.();
  }
}

test("the screen offers small, chosen, with medium and large to move to", async () => {
  const terminal = headlessTerminal(120, 40);
  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: "alice", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user: admin },
    { terminal, exitHooks: false },
  );
  tui.start();
  tui.ctx.push(newForgeScreen(session, tui.ctx));
  try {
    await settleApp(tui);
    terminal.feed(TO_SIZE);
    await settleApp(tui);
    expect(tui.screen.toText()).toContain("small");
    for (const [key, word] of [["\x1b[C", "medium"], ["\x1b[C", "large"], ["\x1b[C", "small"], ["\x1b[D", "large"]] as const) {
      terminal.feed(key);
      await settleApp(tui);
      expect(tui.screen.toText()).toContain(word);
    }
  } finally {
    tui.stop?.();
  }
});

test("choosing medium puts size medium in the plan", async () => {
  const r = await plan("szmed" + "\t".repeat(9) + "\x1b[C");
  expect(r.screen).toContain("The plan");
  expect(r.size).toBe("medium");
});

test("choosing large puts size large in the plan", async () => {
  const r = await plan("szlarge" + "\t".repeat(9) + "\x1b[C\x1b[C");
  expect(r.size).toBe("large");
});

test("small, chosen or left alone, records no size", async () => {
  const left = await plan("szsmall");
  expect(left.screen).toContain("The plan");
  expect(left.size).toBeUndefined();
  const back = await plan("szback" + "\t".repeat(9) + "\x1b[C\x1b[D");
  expect(back.screen).toContain("The plan");
  expect(back.size).toBeUndefined();
});
