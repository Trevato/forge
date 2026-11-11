/** Billing in the terminal (#11134): the admin sees each forge's plan and grants one; no one else is offered it. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { connectStripe } from "../src/actions/billing.ts";
import { connectionOf } from "../src/billing/connection.ts";
import { entitlementOf } from "../src/billing/store.ts";
import { createUser, type User } from "../src/core/users.ts";
import { ok } from "../src/kernel/result.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { usePlacement, useProbe } from "../src/spawn/door.ts";
import { bootHostedChild } from "../src/spawn/host.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { billingScreen, entry } from "../src/tui/screens/billing.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let app: App;
let servers: Servers;
let alice: User;
let bob: User;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-billing-tui-"));
  app = createApp({ dataDir: dir, port: 0, forgeRepo: "alice/forge-code" });
  servers = await serve(app);
  const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "b@forge.local", password: "a-good-passphrase" });
  if (!a.ok || !b.ok) throw new Error("user");
  alice = a.value;
  bob = b.value;
  const code = await createRepo(app, alice, { name: "forge-code", visibility: "public" });
  if (!code.ok) throw new Error("repo");
  await commitToBranch(app, alice, code.value, { message: "v1", files: [{ path: "src/main.ts", content: "1" }] });
  useProbe(app, () => async () => true);
  usePlacement(app, { place: async (p) => ok({ url: `https://${p.name}.fake.test`, bodyId: `fake-${p.name}` }), retire: async () => ok() });
  const res = await fetch(`${servers.url}/api/v1/forges`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "kid", dryRun: false }) });
  expect(res.status).toBe(201);
}, 30_000);
afterAll(async () => {
  await bootHostedChild(app, "kid");
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const key = (k: string) => ({ type: "key" as const, key: k, ctrl: false, alt: false, shift: false });
function open(user: User) {
  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user },
    { terminal: headlessTerminal(120, 40), exitHooks: false },
  );
  tui.start();
  return { tui, session };
}

test("the entry is offered to an admin only", () => {
  expect(entry.offered(open(alice).session)).toBe(true);
  expect(entry.offered(open(bob).session)).toBe(false);
});

test("the admin sees the forge's plan and grants another after a yes", async () => {
  const { tui, session } = open(alice);
  const screen = billingScreen(session, tui.ctx);
  tui.ctx.push(screen);
  await settleApp(tui);
  expect(tui.screen.toText()).toContain("kid");
  expect(tui.screen.toText()).toContain("small");
  tui.dispatch(key("l"));
  await settleApp(tui);
  expect(tui.screen.toText()).toContain("Put kid on large?");
  expect(entitlementOf(app.db, "kid", "small").plan).toBe("small");
  tui.dispatch(key("y"));
  await settleApp(tui);
  expect(entitlementOf(app.db, "kid", "small").plan).toBe("large");
  expect(tui.screen.toText()).toContain("kid is on large.");
  tui.stop?.();
});

test("a no changes nothing", async () => {
  const { tui, session } = open(alice);
  const screen = billingScreen(session, tui.ctx);
  tui.ctx.push(screen);
  await settleApp(tui);
  tui.dispatch(key("s"));
  await settleApp(tui);
  tui.dispatch(key("n"));
  await settleApp(tui);
  expect(entitlementOf(app.db, "kid", "small").plan).toBe("large");
  tui.stop?.();
});

test("a non-admin who reaches the screen sees no forge and cannot grant", async () => {
  const { tui, session } = open(bob);
  const screen = billingScreen(session, tui.ctx);
  tui.ctx.push(screen);
  await settleApp(tui);
  expect(tui.screen.toText()).not.toContain("kid");
  tui.dispatch(key("s"));
  await settleApp(tui);
  expect(entitlementOf(app.db, "kid", "small").plan).toBe("large");
  tui.stop?.();
});

const type = (tui: ReturnType<typeof open>["tui"], text: string) => {
  for (const ch of text) tui.dispatch(key(ch));
};

test("the admin connects Stripe's signing secret, sees it masked, and disconnects after a yes", async () => {
  const k = "sk_test_AbCdEf1234567890";
  expect((await connectStripe(app, alice, k, "whsec_first1234567")).ok).toBe(true);
  expect(connectionOf(app.db)).toEqual({ mode: "sandbox", signed: true });
  const { tui, session } = open(alice);
  tui.ctx.push(billingScreen(session, tui.ctx));
  await settleApp(tui);
  expect(tui.screen.toText()).toContain("Stripe sandbox, signed");
  tui.dispatch(key("w"));
  await settleApp(tui);
  type(tui, "whsec_second123456");
  await settleApp(tui);
  expect(tui.screen.toText()).not.toContain("whsec_second123456");
  tui.dispatch(key("enter"));
  await settleApp(tui);
  expect(tui.screen.toText()).toContain("Signing secret saved.");
  tui.dispatch(key("x"));
  await settleApp(tui);
  expect(tui.screen.toText()).toContain("Remove the webhook and forget the key?");
  tui.dispatch(key("n"));
  await settleApp(tui);
  expect(connectionOf(app.db)).toBeDefined();
  tui.stop?.();
});

test("a bad key typed into the connect prompt is refused in words; a non-admin cannot open the prompt", async () => {
  const { tui, session } = open(alice);
  tui.ctx.push(billingScreen(session, tui.ctx));
  await settleApp(tui);
  tui.dispatch(key("c"));
  await settleApp(tui);
  type(tui, "pk_live_abcdefgh12");
  tui.dispatch(key("enter"));
  await settleApp(tui);
  expect(tui.screen.toText()).toContain("That is not a Stripe secret or restricted key");
  tui.stop?.();
  const bobs = open(bob);
  bobs.tui.ctx.push(billingScreen(bobs.session, bobs.tui.ctx));
  await settleApp(bobs.tui);
  bobs.tui.dispatch(key("x"));
  await settleApp(bobs.tui);
  expect(bobs.tui.screen.toText()).not.toContain("Remove the webhook");
  bobs.tui.stop?.();
});

test("the terminal Billing screen shows the last Stripe event and refusals to an admin, and nothing to a non-admin", async () => {
  const now = new Date().toISOString();
  app.db.query("INSERT OR IGNORE INTO stripe_event (id, type, at) VALUES ('evt_tui', 'invoice.paid', ?1)").run(now);
  app.db.query("INSERT OR IGNORE INTO stripe_hook_refused (day, kind, n) VALUES (?1, 'bad', 2)").run(now.slice(0, 10));
  const mine = open(alice);
  mine.tui.ctx.push(billingScreen(mine.session, mine.tui.ctx));
  await settleApp(mine.tui);
  expect(mine.tui.screen.toText()).toContain("Last event: invoice.paid");
  expect(mine.tui.screen.toText()).toContain("Refused today: 2");
  mine.tui.stop?.();
  const bobs = open(bob);
  bobs.tui.ctx.push(billingScreen(bobs.session, bobs.tui.ctx));
  await settleApp(bobs.tui);
  expect(bobs.tui.screen.toText()).not.toContain("invoice.paid");
  expect(bobs.tui.screen.toText()).not.toContain("Refused today");
  bobs.tui.stop?.();
});
