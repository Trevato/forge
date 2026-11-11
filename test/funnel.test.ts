/**
 * The selling funnel (#11259): a visitor goes home → plan click → free forge
 * and each count moves by one; a scraper's visit moves none; a provider's
 * activation is the paid step; Settings → Billing renders the row and
 * `/api/v1/admin/billing/funnel` and the traffic probe say the same.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { putEntitlement } from "../src/billing/store.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { ok } from "../src/kernel/result.ts";
import { daysOf, funnelReport } from "../src/perf/funnel.ts";
import { funnelRows } from "../src/tui/screens/funnel.ts";
import { funnelJs } from "../src/web/funnel_door.ts";
import { getPlans } from "../src/settings/plans.ts";
import { bootHostedChild } from "../src/spawn/host.ts";
import { usePlacement, useProbe } from "../src/spawn/door.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PERSON = "Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36";
const BOT = "Mozilla/5.0 (compatible; Reflectionbot/1.0)";

let dir: string;
let app: App;
let servers: Servers;
let cookie = "";
let token = "";
let freePlan = "";

const counts = () => Object.fromEntries(funnelReport(app.db, 7).steps.map((s) => [s.id, s.count]));
const home = (agent: string, extra: Record<string, string> = {}) =>
  fetch(`${servers.url}/`, { headers: { "user-agent": agent, ...extra } });
const signal = (agent: string, body: unknown, extra: Record<string, string> = {}) =>
  fetch(`${servers.url}/_funnel`, { method: "POST", headers: { "user-agent": agent, origin: servers.url, ...extra }, body: JSON.stringify(body) });
const makeForge = (agent: string, name: string) =>
  fetch(`${servers.url}/forges/new`, {
    method: "POST",
    redirect: "manual",
    headers: { "user-agent": agent, origin: servers.url, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ name }),
  });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-funnel-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const a = await createUser(app.db, { origin: "seed", trusted: true, username: "ada", email: "ada@forge.local", password: "correct-horse-battery", adminIfFirst: true });
  if (!a.ok) throw new Error(a.error);
  cookie = `forge_session=${createSession(app.db, a.value.id).token}`;
  token = createToken(app.db, a.value.id, "ro", "ro").token;
  freePlan = getPlans(app.db).find((p) => p.priceUsd === 0)?.name ?? "start";
  useProbe(app, () => async () => true);
  usePlacement(app, { place: async (p) => ok({ url: `https://${p.name}.fake.test`, bodyId: `fake-${p.name}` }), retire: async () => ok() });
}, 30_000);

afterAll(async () => {
  await bootHostedChild(app, "funnel-one");
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the selling funnel", () => {
  test("a visitor moves each step by one; a scraper moves none; the home carries the plan hooks", async () => {
    expect(counts()).toEqual({ home: 0, plans: 0, click: 0, forge: 0, paid: 0 });
    const page = await (await home(PERSON)).text();
    expect(page).toContain(`data-plan="${freePlan}"`);
    expect(funnelJs).toContain("/_funnel");
    expect(page).toContain("page-");
    expect(counts()).toMatchObject({ home: 1 });
    expect((await signal(PERSON, { step: "plans" })).status).toBe(204);
    expect(counts()).toMatchObject({ home: 1, plans: 1 });
    expect((await signal(PERSON, { step: "click", plan: freePlan })).status).toBe(204);
    expect(counts()).toMatchObject({ home: 1, plans: 1, click: 1 });
    const made = await makeForge(PERSON, "funnel-one");
    expect(made.status).toBeLessThan(400);
    expect(counts()).toEqual({ home: 1, plans: 1, click: 1, forge: 1, paid: 0 });
    // The same visitor again the same day is the same visit.
    await home(PERSON);
    await signal(PERSON, { step: "plans" });
    expect(counts()).toMatchObject({ home: 1, plans: 1 });

    const before = counts();
    await home(BOT);
    await signal(BOT, { step: "plans" });
    await signal(BOT, { step: "click", plan: freePlan });
    expect(counts()).toEqual(before);
  });

  test("a plan the forge does not offer, a stray field or a cross-origin post stores nothing", async () => {
    const before = counts();
    expect((await signal("Mozilla/5.0 Firefox/130", { step: "click", plan: "nonesuch" })).status).toBe(400);
    expect((await signal("Mozilla/5.0 Firefox/130", { step: "click", plan: freePlan, who: "me" })).status).toBe(400);
    expect((await signal("Mozilla/5.0 Firefox/130", { step: "other" })).status).toBe(400);
    expect((await signal("Mozilla/5.0 Firefox/130", { step: "plans" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await signal("Mozilla/5.0 Firefox/130", { step: "plans" }, { dnt: "1" })).status).toBe(204);
    expect(counts()).toEqual(before);
  });

  test("a provider's activation is the paid step; a hand grant is not", () => {
    putEntitlement(app.db, { forge: "payer", plan: "medium", status: "active", source: "granted", provider: "none" }, "small", "x");
    expect(counts()).toMatchObject({ paid: 0 });
    putEntitlement(app.db, { forge: "payer2", plan: "medium", status: "active", source: "stripe", provider: "stripe" }, "small", "");
    expect(counts()).toMatchObject({ paid: 1 });
    expect(funnelReport(app.db, 7).steps.find((s) => s.id === "paid")!.pct).toBe(100);
  });

  test("referrers of visits that clicked a plan are listed, top five, direct apart", async () => {
    const agent = "Mozilla/5.0 Safari/605 Referred";
    await home(agent, { referer: "https://news.example/story?x=1" });
    await signal(agent, { step: "click", plan: freePlan });
    const r = funnelReport(app.db, 7);
    expect(r.referrers).toContainEqual({ source: "news.example", count: 1 });
    expect(r.referrers).toContainEqual({ source: "(direct)", count: 1 });
    expect(r.clicks_by_plan).toEqual([{ plan: freePlan, count: 2 }]);
    expect(r.referrers.length).toBeLessThanOrEqual(5);
  });

  test("Settings → Billing renders the row; the API and the probe say the same", async () => {
    const r = funnelReport(app.db, 7);
    const page = await (await fetch(`${servers.url}/settings/billing`, { headers: { cookie } })).text();
    const block = /<dl class="status-rows" data-funnel>([\s\S]*?)<\/dl>/.exec(page)?.[1] ?? "";
    const rows = [...block.matchAll(/<dt>([^<]*)<\/dt><dd>([^<]*)<\/dd>/g)].map((m) => [m[1], m[2]]);
    expect(rows.slice(0, 5).map((x) => x[0])).toEqual(["Visits to home", "Saw the plans", "Clicked a plan", "Forges made", "Paid"]);
    expect(rows[0]![1]).toBe(`${r.steps[0]!.count}`);
    expect(rows[1]![1]).toStartWith(`${r.steps[1]!.count}`);
    expect(rows[1]![1]).toContain("of the step before");
    expect(rows).toContainEqual([`Clicked ${freePlan}`, "2"]);
    expect(page).toContain("Plan clicks from ");
    expect(page).toContain("Last 7 days: from visit to paid");
    expect(page).not.toContain("→ ");
    expect(page.indexOf('id="funnel"')).toBeGreaterThan(page.indexOf("<h2>Plans</h2>"));

    const api = await fetch(`${servers.url}/api/v1/admin/billing/funnel?days=7`, { headers: { authorization: `Bearer ${token}` } });
    expect(api.status).toBe(200);
    const body = (await api.json()) as typeof r;
    expect(body.days).toBe(7);
    expect(body.steps.map((s) => s.count)).toEqual(r.steps.map((s) => s.count));
    expect((await fetch(`${servers.url}/api/v1/admin/billing/funnel`)).status).toBe(404);

    const probe = await fetch(`${servers.url}/api/v1/admin/traffic/probe?scope=funnel`, { headers: { authorization: `Bearer ${token}` } });
    const probed = (await probe.json()) as { numbers: { id: string; value: number; recomputed: number; agrees: boolean }[] };
    const steps = probed.numbers.filter((n) => n.id.startsWith("funnel_"));
    expect(steps.map((n) => n.id)).toEqual(["funnel_home", "funnel_plans", "funnel_click", "funnel_forge", "funnel_paid"]);
    expect(steps.every((n) => n.agrees)).toBe(true);
    expect(steps.map((n) => n.value)).toEqual(r.steps.map((s) => s.count));
  });

  test("the terminal's rows are the page's: a step, its share, clicks by plan", () => {
    const r = funnelReport(app.db, 7);
    const rows = funnelRows(r);
    expect(rows.slice(0, 5).map((x) => x.title)).toEqual(r.steps.map((x) => x.label));
    expect(rows.some((x) => x.title === `Clicked ${freePlan}` && x.meta === "2")).toBe(true);
  });

  test("days is a whole number 1 to 90, else a week", () => {
    expect([daysOf(null), daysOf("30"), daysOf("0"), daysOf("91"), daysOf("x"), daysOf("1e2")]).toEqual([7, 30, 7, 7, 7, 7]);
  });
});
