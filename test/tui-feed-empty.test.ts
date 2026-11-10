/** The feed in the terminal says the same one line as the page when there is nothing in it. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir = "";
let forge: App;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-feed-empty-"));
  forge = createApp({ dataDir: dir, port: 0 });
  const made = await createUser(forge.db, {
    origin: "seed", trusted: true, allowReserved: true, username: "root", email: "root@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  promote(forge.db, made.value);
});

afterAll(async () => {
  forge.db.close();
  await rm(dir, { recursive: true, force: true });
});

test("an empty feed says the page's line", async () => {
  const terminal = headlessTerminal(140, 32);
  const identity = { sshUsername: "t", remoteAddress: "127.0.0.1", user: getUserByName(forge.db, "root")! };
  const { app } = createForgeApp(forge, identity, { terminal, exitHooks: false });
  app.start();
  const key = async (k: string, ctrl = false) => {
    app.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    await settleApp(app);
  };
  await key("k", true);
  for (const k of [..."Feed", "enter"]) await key(k);
  const text = app.screen.toText();
  expect(text).toContain("Nothing yet. Tell the crew what to build.");
  expect(text).not.toContain("Nothing in the feed yet");
  app.stop();
});
