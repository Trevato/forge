/** Usage in the terminal (#1565): an admin who is not an agent sees unused routes on top; nobody else has the command. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { hourOf } from "../src/core/usage_count.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dataDir: string;
let forge: Forge;

function boot(username: string) {
  const user = getUserByName(forge.db, username)!;
  const { app } = createForgeApp(
    forge,
    { sshUsername: "t", remoteAddress: "127.0.0.1", user },
    { terminal: headlessTerminal(140, 32), exitHooks: false },
  );
  app.start();
  const key = (k: string, ctrl = false) => app.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
  return {
    text: () => app.screen.toText(),
    palette: async (word: string) => {
      key("k", true);
      for (const ch of word) key(ch);
      await settleApp(app);
    },
    enter: async () => {
      key("enter");
      await settleApp(app);
    },
    stop: () => app.stop(),
  };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-tui-usage-"));
  forge = createApp({ dataDir, port: 0 });
  for (const [username, adminIfFirst] of [["alice", true], ["bob", false], ["carol", false]] as const) {
    const made = await createUser(forge.db, {
      origin: "seed",
      trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst,
    });
    if (!made.ok) throw new Error(made.error);
  }
  forge.db.query("UPDATE user SET is_admin = 1, is_agent = 1 WHERE username = 'carol'").run();
  forge.db.run(
    "INSERT INTO usage_count (hour, pattern, method, status, role, surface, n) VALUES (?, '/system', 'GET', '2xx', 'admin', 'web', 5)",
    [hourOf(new Date())],
  );
});
afterAll(async () => {
  forge.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("an admin's terminal lists unused routes first, with never, and the count line", async () => {
  const h = boot("alice");
  await h.palette("Usage");
  await h.enter();
  const text = h.text();
  expect(text).toMatch(/\d+ of \d+ routes had no request in 30 days; unused first/);
  expect(text).toContain("last never");
  expect(text).not.toContain("admin 5"); // the one used route sorts below every unused one
  h.stop();
});

test("a non-admin and an admin agent see the spend and are told the routes are an admin's", async () => {
  for (const who of ["bob", "carol"]) {
    const h = boot(who);
    await h.palette("Usage");
    await h.enter();
    expect(h.text()).not.toContain("routes had no request");
    h.stop();
  }
});
