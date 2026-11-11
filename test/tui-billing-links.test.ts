/**
 * Buy links in the terminal (#11149): an admin who is a person reads the three
 * sizes and sets one through the same action as the page; a refused address
 * keeps the prompt open and nothing; a member is not offered the screen.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { getBillingLinks } from "../src/settings/billing.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let forge: Forge;

function boot(username: string) {
  const user = getUserByName(forge.db, username)!;
  const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user };
  const { app } = createForgeApp(forge, identity, { terminal: headlessTerminal(140, 32), exitHooks: false });
  app.start();
  const k = (key: string, ctrl = false) => app.dispatch({ type: "key", key, ctrl, alt: false, shift: false });
  return {
    text: () => app.screen.toText(),
    press: async (...keys: string[]) => {
      keys.forEach((x) => k(x));
      await settleApp(app);
    },
    open: async () => {
      k("k", true);
      for (const ch of "Buy links") k(ch);
      k("enter");
      await settleApp(app);
    },
    stop: () => app.stop(),
  };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-billing-"));
  forge = createApp({ dataDir: dir, port: 0 });
  for (const [username, adminIfFirst] of [["alice", true], ["bob", false]] as const) {
    const made = await createUser(forge.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst });
    if (!made.ok) throw new Error(made.error);
  }
});
afterAll(async () => {
  forge.close();
  await rm(dir, { recursive: true, force: true });
});

test("an admin reads the sizes, a bad address is refused, a good one is saved", async () => {
  const h = boot("alice");
  await h.open();
  expect(h.text()).toContain("small");
  expect(h.text()).toContain("no link");
  await h.press("enter");
  for (const ch of "http://insecure.test") await h.press(ch);
  await h.press("enter");
  expect(h.text()).toContain("https address");
  expect(getBillingLinks(forge.db)).toEqual({});
  await h.press("esc");
  h.stop();
  const again = boot("alice");
  await again.open();
  await again.press("j", "enter");
  for (const ch of "https://buy.test/medium") await again.press(ch);
  await again.press("enter");
  expect(getBillingLinks(forge.db)).toEqual({ medium: "https://buy.test/medium" });
  expect(again.text()).toContain("https://buy.test/medium");
  again.stop();
});

test("a member is not offered the screen and cannot set a link", async () => {
  const h = boot("bob");
  await h.open();
  expect(h.text()).not.toContain("no link");
  await h.press("enter");
  expect(getBillingLinks(forge.db)).toEqual({ medium: "https://buy.test/medium" });
  h.stop();
});
