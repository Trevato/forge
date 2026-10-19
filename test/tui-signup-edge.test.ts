/**
 * Behind an edge the terminal cannot know the login the edge will vouch for,
 * so its create-account mode makes no row and points at the page.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB2S7bF0R4NmuTUvVJXPPjdI1AF8XHXeYSNfr8DJ5eDo terminal-test";

let dir: string;
let forge: Forge;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-edge-signup-"));
  forge = createApp({ dataDir: dir, port: 0, url: "https://forge.example", edgeToken: "edge-secret", disk: () => ({ freeBytes: 95, totalBytes: 100 }) });
});
afterAll(async () => {
  forge.close();
  await rm(dir, { recursive: true, force: true });
});

test("with an edge token the terminal sign-up makes no row", async () => {
  const identity: TuiIdentity = { sshUsername: "git", remoteAddress: "198.51.100.7", fingerprint: "SHA256:x", publicKey: KEY };
  const { app } = createForgeApp(forge, identity, { terminal: headlessTerminal(120, 32), exitHooks: false });
  app.start();
  const key = (k: string, ctrl = false): void =>
    app.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
  const type = (t: string): void => [...t].forEach((c) => key(c));
  try {
    await settleApp(app);
    key("s");
    await settleApp(app);
    key("t", true); // no create mode to switch to
    await settleApp(app);
    expect(app.screen.toText()).not.toContain("Email");
    expect(app.screen.toText()).toContain("Sign up on the web page only");
    expect(app.screen.toText()).toContain("https://forge.example/signup");
    type("mallory");
    key("tab");
    type("a-long-passphrase");
    key("enter");
    await settleApp(app);
    expect(getUserByName(forge.db, "mallory")).toBeFalsy();
  } finally {
    app.stop();
  }
});
