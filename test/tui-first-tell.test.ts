/** The terminal's home of a new forge: before the first tell, "what do you want built" and no everyday offer; after it, the offer. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { getUserById } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { claimedForge, type ClaimedForge } from "./helpers/claimed-forge.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let forge: ClaimedForge;
beforeAll(async () => {
  forge = await claimedForge("forge-tui-first-tell-");
}, 60_000);
afterAll(() => forge.stop());

function boot() {
  const row = forge.child.db.query<{ id: string }, []>("SELECT id FROM user WHERE is_admin = 1 AND is_agent = 0 AND kind = 'user' LIMIT 1").get()!;
  const user = getUserById(forge.child.db, row.id)!;
  const { app } = createForgeApp(
    forge.child,
    { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user },
    { terminal: headlessTerminal(200, 32), exitHooks: false },
  );
  app.start();
  const key = async (k: string) => {
    app.dispatch({ type: "key", key: k, ctrl: false, alt: false, shift: false });
    await settleApp(app);
  };
  return { app, key, text: () => app.screen.toText() };
}

test("before the first tell the home says what to do and offers no everyday account; after it, the offer", async () => {
  const h = boot();
  await settleApp(h.app);
  expect(h.text()).toContain("What do you want built?");
  expect(h.text()).toContain("included credit.");
  expect(h.text()).not.toContain("K keeps using admin");

  await h.key("t");
  for (const ch of "A weekly menu page") await h.key(ch);
  await h.key("enter");
  expect(forge.child.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM thought").get()!.n).toBe(1);
  h.app.stop();

  // Once the crew has made an issue of it, the home is the everyday one and offers the account.
  const told = await forge.post(forge.owner, "/marias/bakery/tell", { text: "Add a weekly menu page." });
  expect(told.status).toBeLessThan(400);
  const after = boot();
  await settleApp(after.app);
  expect(after.text()).not.toContain("What do you want built?");
  expect(after.text()).toContain("K keeps using admin");
  after.app.stop();
});
