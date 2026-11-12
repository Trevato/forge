/** /pricing in the terminal (#11369): plans, an order through placeOrder, the checkout address as text, the claim link by the same ticket. */
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { childDirOf } from "../src/actions/spawn.ts";
import { deliverLink, NO_PROVIDER, reconcileOrder } from "../src/actions/order.ts";
import { useCheckout, type CheckoutProvider } from "../src/billing/checkout.ts";
import { getOrder, MAX_PENDING_PER_ADDRESS, pendingFrom } from "../src/billing/orders.ts";
import { createUser } from "../src/core/users.ts";
import { bucketOf } from "../src/http/peer.ts";
import { setStrangerLimits, strangerLimits } from "../src/http/strangers.ts";
import { err, ok } from "../src/kernel/result.ts";
import { FREE, getPlans, setPlans } from "../src/settings/plans.ts";
import { usePlacement, useProbe } from "../src/spawn/door.ts";
import { createForgeApp, forgeCommands, Session } from "../src/tui/forge.ts";
import { pricingScreen } from "../src/tui/screens/pricing.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A forge of its own for one test: its own data, its own fake provider, its own counts. */
async function fixture(opts: { sell?: boolean; placement?: "ok" | "full" } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "forge-tui-pricing-"));
  dirs.push(dir);
  const app: App = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
  const paid = new Set<string>();
  let placed = 0;
  const provider: CheckoutProvider = {
    name: "fake",
    async create(req) {
      const id = `cs_fake_${req.orderId.slice(4, 16)}`;
      return ok({ id, url: `https://pay.fake.test/${id}` });
    },
    async state(id) {
      return ok({ paid: paid.has(id), customer: "cus_1", subscription: "sub_1" });
    },
  };
  useProbe(app, () => async () => true);
  usePlacement(app, {
    place: async (plan: { name: string }) =>
      opts.placement === "full" ? err({ kind: "refused", reason: "capacity", message: "no room" }) : ok({ url: `https://${plan.name}.fake.test`, bodyId: `fake-${++placed}` }),
    retire: async () => ok(),
  } as never);
  if (opts.sell !== false) useCheckout(app, provider);
  const identity = (addr: string) => ({ sshUsername: "git", remoteAddress: addr, fingerprint: "SHA256:test", user: undefined });
  const open = (addr: string) => {
    const terminal = headlessTerminal(120, 40);
    const { app: tui, session } = createForgeApp(app, identity(addr) as never, { terminal, exitHooks: false });
    tui.start();
    tui.ctx.push(pricingScreen(session, tui.ctx));
    return { tui, terminal, session };
  };
  /** Press keys and wait until the terminal is quiet: the placement and the provider are awaited by the app's own tracking. */
  const press = async (h: ReturnType<typeof open>, keys: string) => {
    h.terminal.feed(keys);
    await settleApp(h.tui);
  };
  const orderRow = (name: string) => app.db.query<{ id: string; email: string; state: string }, [string]>("SELECT id, email, state FROM forge_order WHERE name = ?1").get(name);
  return { app, paid, placed: () => placed, open, press, orderRow, identity };
}

const flat = (h: { tui: { screen: { toText(): string } } }) => h.tui.screen.toText().replace(/\s+/g, " ");
const joined = (h: { tui: { screen: { toText(): string } } }) => h.tui.screen.toText().replace(/\s+/g, "");
const sessionOf = (h: { tui: { screen: { toText(): string } } }) => joined(h).match(/https:\/\/pay\.fake\.test\/(cs_fake_[0-9a-f]{12})/)?.[1];

/** Place an order from a fresh screen and return it, waiting at the checkout address. */
async function ordered(f: Awaited<ReturnType<typeof fixture>>, addr: string, name: string) {
  const h = f.open(addr);
  await settleApp(h.tui);
  await f.press(h, `${name}\tbuyer@example.com\r`);
  const session = sessionOf(h);
  expect(session).toBeDefined();
  return { h, session: session! };
}

test("the palette offers it to everyone", async () => {
  const f = await fixture();
  expect(forgeCommands(new Session(f.app, f.identity("203.0.113.9") as never))({} as never).map((c) => c.id)).toContain("pricing");
});

test("the plans are listed with their prices", async () => {
  const f = await fixture();
  const h = f.open("203.0.113.1");
  await settleApp(h.tui);
  const text = flat(h);
  for (const p of getPlans(f.app.db)) if (p.key !== FREE && p.priceUsd > 0) expect(text).toContain(`$${p.priceUsd} a month`);
});

test("a bad email is refused in the web's words and holds nothing", async () => {
  const f = await fixture();
  const h = f.open("203.0.113.2");
  await settleApp(h.tui);
  await f.press(h, "sunny-day\tnot-an-email\r");
  expect(flat(h)).toContain("Enter the email the link should go to");
  expect(pendingFrom(f.app.db, bucketOf("203.0.113.2"), Date.now())).toBe(0);
});

test("an order prints the checkout address, and the same ticket brings the claim link once after payment", async () => {
  const f = await fixture();
  const { h, session } = await ordered(f, "203.0.113.3", "sunny-day");
  expect(pendingFrom(f.app.db, bucketOf("203.0.113.3"), Date.now())).toBe(1);
  await f.press(h, "r");
  expect(flat(h)).toContain("Not paid yet");
  f.paid.add(session);
  await f.press(h, "r"); // the reconcile is awaited by the app: the forge is made before it settles
  expect(joined(h)).toMatch(/https:\/\/sunny-day--forge\.test\/claim#/);
  expect(f.placed()).toBe(1);
});

test("the claim link is shown once: a screen whose order's link was already taken is told so", async () => {
  const f = await fixture();
  const { h, session } = await ordered(f, "203.0.113.5", "once-only");
  f.paid.add(session);
  // The link is taken elsewhere first (the web's return page, say); this screen asks after.
  const id = f.orderRow("once-only")!.id;
  await reconcileOrder(f.app, id);
  expect((await deliverLink(f.app, getOrder(f.app.db, id)!)).kind).toBe("link");
  await f.press(h, "r");
  expect(flat(h)).toContain("The link was shown already");
  expect(joined(h)).not.toContain("/claim#");
});

test("a paid order whose forge cannot be made says so and keeps the order id", async () => {
  const f = await fixture({ placement: "full" });
  const { h, session } = await ordered(f, "203.0.113.7", "no-room");
  f.paid.add(session);
  await f.press(h, "r");
  expect(flat(h)).toContain("Paid, but the forge could not be made");
  expect(flat(h)).toContain(f.orderRow("no-room")!.id);
  expect(joined(h)).not.toContain("/claim#");
});

test("a forge already taken over is told so, and no link is shown", async () => {
  const f = await fixture();
  const { h, session } = await ordered(f, "203.0.113.8", "taken-over");
  f.paid.add(session);
  // Paid and made by the webhook's route, before this screen asks.
  await reconcileOrder(f.app, f.orderRow("taken-over")!.id);
  // Someone claims the child: it has an admin.
  const child = createApp({ dataDir: childDirOf(f.app, "fake-1") });
  try {
    const made = await createUser(child.db, { origin: "seed", trusted: true, username: "keeper", email: "o@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!made.ok) throw new Error(JSON.stringify(made.error));
    child.db.query("UPDATE user SET is_admin = 1 WHERE username = 'keeper'").run();
  } finally {
    child.close();
  }
  await f.press(h, "r");
  expect(flat(h)).toContain("is taken over");
  expect(joined(h)).not.toContain("/claim#");
});

test("a ticket that does not fit the order shows no link, and the screen says why", async () => {
  const f = await fixture();
  const { h, session } = await ordered(f, "203.0.113.10", "not-yours");
  f.paid.add(session);
  f.app.db.query("UPDATE forge_order SET ticket_hash = 'someone-elses' WHERE name = 'not-yours'").run();
  await f.press(h, "r");
  expect(flat(h)).toContain("not yours to see");
  expect(joined(h)).not.toContain("/claim#");
  expect(f.placed()).toBe(0);
  expect(f.orderRow("not-yours")!.state).toBe("pending");
});

test("the per-address cap counts the terminal's bucket", async () => {
  const f = await fixture();
  const addr = "203.0.113.4";
  for (let i = 0; i < MAX_PENDING_PER_ADDRESS; i++) await ordered(f, addr, `cap-${i}`);
  expect(pendingFrom(f.app.db, bucketOf(addr), Date.now())).toBe(MAX_PENDING_PER_ADDRESS);
  const h = f.open(addr);
  await settleApp(h.tui);
  await f.press(h, "one-more\tb@example.com\r");
  expect(flat(h)).toContain("You have orders waiting already");
});

test("a visitor who tries too often is told when to come back, and nothing is held", async () => {
  const f = await fixture();
  setStrangerLimits(f.app, { perAddress: { ...strangerLimits(f.app).perAddress, plan: 2 } });
  const addr = "203.0.113.11";
  const h = f.open(addr);
  await settleApp(h.tui);
  for (let i = 0; i < 2; i++) await f.press(h, "\r"); // two tries (refused for the empty name, but counted)
  expect(flat(h)).not.toContain("Too many tries");
  await f.press(h, "sunny-day\tbuyer@example.com\r");
  expect(flat(h)).toMatch(/Too many tries from here; try again in \d+s/);
  expect(pendingFrom(f.app.db, bucketOf(addr), Date.now())).toBe(0);
});

test("up and down choose the paid plan and wrap; the order is made on the chosen one", async () => {
  const f = await fixture();
  const paidPlans = getPlans(f.app.db).filter((p) => p.key !== FREE && p.priceUsd > 0);
  const h = f.open("203.0.113.12");
  await settleApp(h.tui);
  const marked = () => h.tui.screen.toText().split("\n").find((l) => l.includes("▸"))!;
  expect(marked()).toContain(paidPlans[0]!.name);
  await f.press(h, "\x1b[A"); // up from the first wraps to the last
  expect(marked()).toContain(paidPlans[paidPlans.length - 1]!.name);
  await f.press(h, "\x1b[B"); // down from the last wraps to the first
  expect(marked()).toContain(paidPlans[0]!.name);
  await f.press(h, "\x1b[B");
  expect(marked()).toContain(paidPlans[1]!.name);
  await f.press(h, "picked-two\tbuyer@example.com\r");
  expect(f.app.db.query<{ plan: string }, []>("SELECT plan FROM forge_order WHERE name = 'picked-two'").get()!.plan).toBe(paidPlans[1]!.key);
});

test("with no paid plan there is nothing to order, and the screen says so at once", async () => {
  const f = await fixture();
  setPlans(f.app.db, getPlans(f.app.db).filter((p) => p.key === FREE), "test");
  const h = f.open("203.0.113.13");
  await settleApp(h.tui);
  await f.press(h, "sunny-day\tbuyer@example.com\r");
  expect(flat(h)).toContain(NO_PROVIDER);
  expect(pendingFrom(f.app.db, bucketOf("203.0.113.13"), Date.now())).toBe(0);
});

test("with no provider the form says paid plans are not on sale and refuses the order", async () => {
  const f = await fixture({ sell: false });
  const h = f.open("203.0.113.14");
  await settleApp(h.tui);
  expect(flat(h)).toContain("not on sale here yet");
  await f.press(h, "sunny-day\tbuyer@example.com\r");
  expect(flat(h)).toContain(NO_PROVIDER);
});

test("a paste has its whitespace stripped and is capped at 254 for the email", async () => {
  const f = await fixture();
  const h = f.open("203.0.113.15");
  await settleApp(h.tui);
  await f.press(h, "\x1b[200~sunny\n day \x1b[201~");
  await f.press(h, "\t");
  const long = `${"a".repeat(64)}@${"b".repeat(235)}`; // 300 characters
  await f.press(h, `\x1b[200~ ${long}\r\x1b[201~`);
  await f.press(h, "\r");
  const row = f.orderRow("sunnyday");
  expect(row).not.toBeNull();
  expect(row!.email).toBe(long.slice(0, 254));
  expect(row!.email.length).toBe(254);
});

test("a pasted name is capped at 60 characters", async () => {
  const f = await fixture();
  const h = f.open("203.0.113.16");
  await settleApp(h.tui);
  await f.press(h, `\x1b[200~${"a".repeat(30)} ${"b".repeat(50)}\x1b[201~`);
  // Over 38 it is refused by the name's own rule; the field holds 60 and no more.
  const text = h.tui.screen.toText();
  expect(text).toContain("b".repeat(30));
  expect(text).not.toContain("b".repeat(31));
});

test("c copies the checkout address through the terminal", async () => {
  const f = await fixture();
  const { h, session } = await ordered(f, "203.0.113.17", "copy-me");
  h.terminal.takeOutput();
  await f.press(h, "c");
  const wanted = Buffer.from(`https://pay.fake.test/${session}`, "utf8").toString("base64");
  expect(h.terminal.takeOutput()).toContain(`\x1b]52;c;${wanted}\x07`);
});

test("an address longer than the screen is cut into rows that read back as it", async () => {
  const f = await fixture();
  const h = f.open("203.0.113.18");
  h.terminal.resize(40, 30);
  await settleApp(h.tui);
  await f.press(h, "wrapped-address\tbuyer@example.com\r");
  expect(sessionOf(h)).toMatch(/^cs_fake_/);
});
