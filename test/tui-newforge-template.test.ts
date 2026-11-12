/**
 * The terminal's new-forge screen offers the web form's Template, Blank first
 * (#7933), and the chosen one reaches the plan the door makes.
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
  dir = await mkdtemp(join(tmpdir(), "forge-tui-newforge-template-"));
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

const TO_TEMPLATE = "\t".repeat(10); // name … Size, then Template

async function open(keys: string): Promise<string> {
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
    terminal.feed(keys);
    await settleApp(tui);
    return tui.screen.toText();
  } finally {
    tui.stop?.();
  }
}

test("the Template field shows blank first, and right moves to starter and back", async () => {
  expect(await open(TO_TEMPLATE)).toContain("blank");
  expect(await open(TO_TEMPLATE + "\x1b[C")).toContain("starter");
  expect(await open(TO_TEMPLATE + "\x1b[C\x1b[C")).toContain("blank");
});

test("choosing starter puts the template in the plan, from the door's body", async () => {
  const screen = await open("tplstar" + TO_TEMPLATE + "\x1b[C\x10");
  expect(screen).toContain("The plan");
  expect(screen).toContain("Template: Starter app.");
});

test("blank, chosen or left alone, names no template in the plan", async () => {
  for (const keys of ["tplblank\x10", "tplback" + TO_TEMPLATE + "\x1b[C\x1b[D\x10"]) {
    const screen = await open(keys);
    expect(screen).toContain("The plan");
    expect(screen).not.toContain("Template:");
  }
});
