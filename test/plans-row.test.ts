/**
 * The anonymous home's plans (#11139): each plan says what it costs and what
 * it is; with provider `none` a paid plan reads "Paid" and the free plan
 * "Free", with `stripe` the prices show; one button to /forges/new. The home
 * reads signup, plans and buy links in one statement (`settings/door.ts`),
 * each falling back to its default on a stored value that does not parse.
 * The terminal's "Get your own forge" prints the same words to a guest.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { billingProvider } from "../src/billing/provider.ts";
import { planWords } from "../src/billing/plan_words.ts";
import { DEFAULT_PLANS } from "../src/settings/plans.ts";
import { getDoorSettings } from "../src/settings/door.ts";
import { sizeWords } from "../src/settings/billing.ts";
import { SIGNUP_DEFAULT } from "../src/settings/signup.ts";
import { plansRow } from "../src/web/plans_row.ts";
import { getForgeLines } from "../src/tui/screens/getforge.ts";
import { forgeCommands, Session } from "../src/tui/forge.ts";

const FREE = DEFAULT_PLANS.find((p) => p.priceUsd === 0)!;
const SMALL = DEFAULT_PLANS.find((p) => p.key === "small")!;

test("provider none: a paid plan reads Paid, the free plan Free, no dollar price; each says what it is", () => {
  const none = plansRow(DEFAULT_PLANS, {}, false).toString();
  for (const p of DEFAULT_PLANS) {
    expect(none).toContain(p.name);
    expect(none).toContain(sizeWords(p.size));
  }
  expect(none).not.toContain("$");
  expect(none).not.toContain("a month");
  expect(planWords(FREE, false).price).toBe("Free");
  expect(planWords(SMALL, false).price).toBe("Paid");
});

test("provider stripe: the prices show; the free plan is still Free", () => {
  const priced = plansRow(DEFAULT_PLANS, {}, true).toString();
  expect(priced).toContain("$19 a month");
  expect(priced).toContain("$149 a month");
  expect(planWords(FREE, true).price).toBe("Free");
});

test("a buy link shows on a paid plan of its size, never on the free plan", () => {
  const links = { small: "https://buy.example/small" };
  expect(planWords(SMALL, false, links).buy).toBe(links.small);
  expect(planWords(FREE, false, links).buy).toBeUndefined();
});

test("the provider is none unless stripe is named", () => {
  expect(billingProvider({})).toBe("none");
  expect(billingProvider({ FORGE_BILLING_PROVIDER: "x" })).toBe("none");
  expect(billingProvider({ FORGE_BILLING_PROVIDER: "stripe" })).toBe("stripe");
});

let dataDir: string;
let app: App;
let servers: Servers;
const saved = process.env["FORGE_BILLING_PROVIDER"];

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-plans-row-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
});

afterEach(() => {
  if (saved === undefined) delete process.env["FORGE_BILLING_PROVIDER"];
  else process.env["FORGE_BILLING_PROVIDER"] = saved;
  app.db.run("DELETE FROM forge_setting WHERE key IN ('signup', 'plans', 'billing.links')");
});

afterAll(async () => {
  await servers.stop?.();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const put = (key: string, value: string): void => {
  app.db.run("INSERT INTO forge_setting (key, value, updated_by, updated_at) VALUES (?1, ?2, 'test', '2026-11-11')", [key, value]);
};

const yours = async (): Promise<string> => {
  const body = await (await fetch(`${servers.url}/`)).text();
  return body.slice(body.indexOf('id="yours"'), body.indexOf('class="door-org"'));
};

test("the signed-out home shows each plan and one button to a page that exists", async () => {
  delete process.env["FORGE_BILLING_PROVIDER"];
  const section = await yours();
  for (const p of DEFAULT_PLANS) expect(section).toContain(p.name);
  expect(section).toContain('href="/forges/new"');
  expect(section).not.toContain("/pricing");
  expect(section).not.toContain("$19 a month");
  expect(section).toContain("Paid");
  expect(section.match(/data-size="lg"/g)).toHaveLength(1);
  expect((await fetch(`${servers.url}/forges/new`)).status).toBe(200);
});

test("with FORGE_BILLING_PROVIDER=stripe the real home shows the prices, read per request", async () => {
  process.env["FORGE_BILLING_PROVIDER"] = "stripe";
  const section = await yours();
  expect(section).toContain("$19 a month");
  expect(section).toContain("$49 a month");
  expect(section).toContain("$149 a month");
  expect(section).not.toContain(">Paid<");
});

test("getDoorSettings reads signup, plans and links in one statement", () => {
  put("signup", "invite");
  put("billing.links", JSON.stringify({ medium: "https://buy.example/medium" }));
  const plans = [{ key: "free", name: "Gratis", says: "Free.", size: "small", priceUsd: 0, creditUsd: 0, forges: 1 }];
  put("plans", JSON.stringify(plans));
  const read = getDoorSettings(app.db);
  expect(read.mode).toBe("invite");
  expect(read.plans.map((p) => p.name)).toEqual(["Gratis"]);
  expect(read.links).toEqual({ medium: "https://buy.example/medium" });
});

test("getDoorSettings: nothing stored, or a stored value that does not parse, reads as the defaults", () => {
  const empty = getDoorSettings(app.db);
  expect(empty).toEqual({ mode: SIGNUP_DEFAULT, plans: DEFAULT_PLANS.map((p) => ({ ...p })), links: {} });
  put("signup", "sometimes");
  put("plans", "{not json");
  put("billing.links", "[1]");
  expect(getDoorSettings(app.db)).toEqual(empty);
});

test("the terminal's Get your own forge: plans, the pointer to /forges/new and self-hosting", () => {
  const lines = getForgeLines(app, 80, false).join("\n");
  for (const p of DEFAULT_PLANS) expect(lines).toContain(p.name);
  expect(lines).toContain("Paid");
  expect(lines).not.toContain("$19 a month");
  expect(lines).toContain("/forges/new");
  expect(lines).toContain("git clone");
  expect(getForgeLines(app, 80, true).join("\n")).toContain("$19 a month");
});

test("a guest in the terminal is offered Get your own forge", () => {
  const guest = new Session(app, { sshUsername: "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user: undefined });
  expect(forgeCommands(guest)({} as never).map((c) => c.id)).toContain("get-a-forge");
});
