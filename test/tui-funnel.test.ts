/** From visit to paid in the terminal (#11259): an admin person is offered it and reads the steps; a member is offered nothing. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
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
    palette: async (query: string) => {
      k("k", true);
      for (const ch of query) k(ch);
      await settleApp(app);
      const seen = app.screen.toText();
      k("enter");
      await settleApp(app);
      return seen;
    },
    stop: () => app.stop(),
  };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-funnel-"));
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

test("an admin opens it and reads every step", async () => {
  const h = boot("alice");
  await h.palette("From visit to paid");
  const t = h.text();
  for (const label of ["Visits to home", "Saw the plans", "Clicked a plan", "Forges made", "Paid"]) expect(t).toContain(label);
  h.stop();
});

test("a member is offered nothing", async () => {
  const h = boot("bob");
  const seen = await h.palette("From visit to paid");
  expect(seen).not.toContain("the last 7 days: home visits");
  expect(h.text()).not.toContain("Visits to home");
  h.stop();
});
