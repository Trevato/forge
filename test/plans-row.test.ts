/**
 * The anonymous home's plans (#11139): each plan says what it costs and what
 * it is; the price is the plans
 * setting's, the free plan reads "Free"; one button to /forges/new. The home
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
import { AFTER_PAYMENT, planWords } from "../src/billing/plan_words.ts";
import { DEFAULT_PLANS } from "../src/settings/plans.ts";
import { getDoorSettings } from "../src/settings/door.ts";
import { sizeWords } from "../src/settings/billing.ts";
import { SIGNUP_DEFAULT } from "../src/settings/signup.ts";
import { plansRow } from "../src/web/plans_row.ts";
import { getForgeLines } from "../src/tui/screens/getforge.ts";
import { forgeCommands, Session } from "../src/tui/forge.ts";

const FREE = DEFAULT_PLANS.find((p) => p.priceUsd === 0)!;
const SMALL = DEFAULT_PLANS.find((p) => p.key === "small")!;

test("every plan shows its price from the plans setting, the free plan Free; no Paid anywhere", () => {
  const row = plansRow(DEFAULT_PLANS, {}).toString();
  for (const p of DEFAULT_PLANS) {
    expect(row).toContain(p.name);
    expect(row).toContain(sizeWords(p.size));
  }
  for (const t of ["$19 a month", "$49 a month", "$149 a month", "$5 of crew credit each month"]) expect(row).toContain(t);
  expect(row).not.toContain("Paid");
  expect(planWords(FREE).price).toBe("Free");
  expect(planWords(SMALL).price).toBe("$19 a month");
});

test("with no buy links the plans carry no action of their own: the one button is the home's", () => {
  const row = plansRow(DEFAULT_PLANS, {}).toString();
  expect(row).not.toContain("<a ");
  expect(row).not.toContain("after payment");
});

test("a buy link shows on a paid plan of its size, never on the free plan", () => {
  const links = { small: "https://buy.example/small" };
  expect(planWords(SMALL, links).buy).toBe(links.small);
  expect(planWords(FREE, links).buy).toBeUndefined();
});

let dataDir: string;
let app: App;
let servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-plans-row-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
});

afterEach(() => {
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
  const section = await yours();
  for (const p of DEFAULT_PLANS) expect(section).toContain(p.name);
  expect(section).toContain('href="/forges/new"');
  expect(section).not.toContain("/pricing");
  expect(section).toContain("$19 a month");
  expect(section).not.toContain("Paid");
  expect(section).not.toContain("Get Free");
  expect(section.match(/data-size="lg"/g)).toHaveLength(1);
  expect((await fetch(`${servers.url}/forges/new`)).status).toBe(200);
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
  const lines = getForgeLines(app).join("\n");
  for (const p of DEFAULT_PLANS) expect(lines).toContain(p.name);
  expect(lines).toContain("$19 a month");
  expect(lines).not.toContain("Paid");
  expect(lines).toContain("/forges/new");
  expect(lines).toContain("git clone");
});

test("a guest in the terminal is offered Get your own forge", () => {
  const guest = new Session(app, { sshUsername: "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user: undefined });
  expect(forgeCommands(guest)({} as never).map((c) => c.id)).toContain("get-a-forge");
});

test("a paid plan keeps its own sentence and adds its credit after it", () => {
  expect(planWords(SMALL).is).toBe(`${sizeWords(SMALL.size)}. ${SMALL.says} $${SMALL.creditUsd} of crew credit each month.`);
  expect(planWords(FREE).is).toBe(`${sizeWords(FREE.size)}. ${FREE.says}`);
});

test("the terminal says Get <plan> and the after-payment line when links are set, neither without", () => {
  expect(getForgeLines(app, 200).join("\n")).not.toContain(AFTER_PAYMENT);
  put("billing.links", JSON.stringify({ small: "https://buy.example/s" }));
  const lines = getForgeLines(app, 200);
  expect(lines).toContain("    Get Small: https://buy.example/s");
  expect(lines).toContain(AFTER_PAYMENT);
  expect(lines.join("\n")).not.toContain("Pay");
});

test("with buy links set the plans show price, credit, Get anchors and the after-payment line; no Paid, Pay for, or closed-forge text", async () => {
  put("signup", "closed");
  put("billing.links", JSON.stringify({ small: "https://buy.example/s", medium: "https://buy.example/m", large: "https://buy.example/l" }));
  const section = await yours();
  for (const t of ["$19 a month", "$49 a month", "$149 a month", "$5 of crew credit each month", "$15 of crew credit each month", "$50 of crew credit each month", "Your forge is made after payment"])
    expect(section).toContain(t);
  for (const n of ["Small", "Medium", "Large"]) expect(section).toContain(`>Get ${n}</a>`);
  expect(section).not.toContain("Get Free");
  expect(section).not.toContain("usually within");
  expect(section).not.toContain("Paid");
  expect(section).not.toContain("Pay for");
  expect(section).not.toContain("not taking new accounts");
});

test("changing a price in the plans setting changes the page", async () => {
  put("billing.links", JSON.stringify({ small: "https://buy.example/s" }));
  put("plans", JSON.stringify(DEFAULT_PLANS.map((p) => (p.key === "small" ? { ...p, priceUsd: 23, creditUsd: 7 } : p))));
  const section = await yours();
  expect(section).toContain("$23 a month");
  expect(section).toContain("$7 of crew credit each month");
  expect(section).not.toContain("$19 a month");
});
