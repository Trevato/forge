/**
 * The Plan row in the terminal (#11141): an admin reads the plan line and
 * sets the billing portal through the page's own action; a member is not
 * offered the screen.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { keepNotice } from "../src/billing/notice.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { getPortalUrl } from "../src/settings/billing.ts";
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
  const k = (key: string) => app.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
  return {
    text: () => app.screen.toText(),
    press: async (...keys: string[]) => {
      keys.forEach((x) => k(x));
      await settleApp(app);
    },
    open: async () => {
      app.dispatch({ type: "key", key: "k", ctrl: true, alt: false, shift: false });
      for (const ch of "Plan") k(ch);
      k("enter");
      await settleApp(app);
    },
    stop: () => app.stop(),
  };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-plan-"));
  forge = createApp({ dataDir: dir, port: 0 });
  for (const [username, adminIfFirst] of [["alice", true], ["bob", false]] as const) {
    const made = await createUser(forge.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst });
    if (!made.ok) throw new Error(made.error);
  }
  await writeFile(join(dir, "parent.json"), JSON.stringify({ upstream: "https://host.example" }));
  keepNotice(dir, { name: "Medium", size: "medium", priceUsd: 49, creditUsd: 10, status: "grace", periodEnd: 1_900_000_000 });
});
afterAll(async () => {
  forge.close();
  await rm(dir, { recursive: true, force: true });
});

test("an admin reads the plan line and sets the portal; a bad address keeps nothing", async () => {
  const h = boot("alice");
  await h.open();
  expect(h.text()).toContain("Medium");
  expect(h.text()).toContain("Past due, sleeps 2030-");
  await h.press("enter");
  for (const ch of "http://insecure.test") await h.press(ch);
  await h.press("enter");
  expect(getPortalUrl(forge.db)).toBe("");
  await h.press("esc");
  h.stop();
  const again = boot("alice");
  await again.open();
  await again.press("enter");
  for (const ch of "https://billing.test/login") await again.press(ch);
  await again.press("enter");
  expect(getPortalUrl(forge.db)).toBe("https://billing.test/login");
  again.stop();
});

test("a member is not offered the screen", async () => {
  const h = boot("bob");
  await h.open();
  expect(h.text()).not.toContain("Billing portal");
  h.stop();
});
