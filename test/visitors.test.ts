import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { browserOf, cookieId, mintId, osOf, prefixOf, probableId } from "../src/perf/visitor_id.ts";
import { linkVisitor, noteVisitor, purgeVisitors, KEEP_MS } from "../src/perf/visitor_store.ts";
import { visitorsReport, probeVisitors } from "../src/perf/visitor_report.ts";
import { getReturning, setReturning } from "../src/settings/returning.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { linkRequestVisitor } from "../src/perf/visitor_link.ts";
import { loadKey } from "../src/kernel/secret.ts";
import { returningLines } from "../src/tui/screens/returning.ts";
import type { Session } from "../src/tui/session.ts";

let dir: string;
let app: App;
let servers: Servers;
let base: string;
let key: Buffer;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "visitors-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  base = `http://127.0.0.1:${servers.port}`;
  key = loadKey(dir);
});
afterAll(async () => {
  await servers.stop();
  await rm(dir, { recursive: true, force: true });
});

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const DAY = 86_400_000;
const T0 = Date.parse("2026-11-01T10:00:00Z");
const beacon = (headers: Record<string, string> = {}) =>
  fetch(`${base}/_measure`, {
    method: "POST",
    headers: { origin: base, "user-agent": CHROME, "accept-language": "en-GB,en;q=0.8", ...headers },
    body: JSON.stringify({ path: "/", ttfb: 40, load: 300, lcp: 250, inp: 80, cls: 0.02 }),
  });
const count = (table = "visitor") => (app.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const wipe = () => {
  app.db.exec("DELETE FROM visitor; DELETE FROM visitor_visit");
};

describe("a returning visitor", () => {
  test("every forge reads the setting off until its owner turns it on, and an owner can change it", () => {
    expect(getReturning(app.db)).toBe(false);
    expect(app.db.query("SELECT COUNT(*) AS n FROM forge_setting WHERE key = 'traffic.returning'").get()).toEqual({ n: 0 });
    setReturning(app.db, true, "u");
    expect(getReturning(app.db)).toBe(true);
    app.db.exec("DELETE FROM forge_setting WHERE key = 'traffic.returning'");
    expect(getReturning(app.db)).toBe(false);
    setReturning(app.db, false, "u");
    expect(getReturning(app.db)).toBe(false);
  });

  test("with the setting off nothing is stored and no cookie is set", async () => {
    wipe();
    const res = await beacon();
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(count()).toBe(0);
  });

  test("the first view sets a first-party cookie with every attribute, and the same cookie on two days is one returning visitor with two visits", async () => {
    setReturning(app.db, true, "u");
    wipe();
    const first = await beacon();
    const line = first.headers.get("set-cookie")!;
    expect(line).toMatch(/^forge_visitor=c[0-9a-f]{32}\.[0-9a-f]{32}; /);
    for (const part of ["Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${396 * 86_400}`]) expect(line).toContain(part);
    expect(line).not.toContain("Domain");
    const id = cookieId(line, key)!;
    expect(id).toBeDefined();
    // The same cookie, on two different days.
    noteVisitor(app.db, { id, kind: "cookie", path: "/", ref: "news.example", step: 1, at: T0 });
    noteVisitor(app.db, { id, kind: "cookie", path: "/plans?x=1", ref: "", step: 2, at: T0 + 3 * DAY });
    const r = visitorsReport(app.db, 30, T0 + 4 * DAY);
    const mine = r.returning.find((v) => v.id === id.slice(0, 9))!;
    expect(mine).toMatchObject({ visits: 2, daysSeen: 2, probable: false, firstRef: "news.example", step: "clicked a plan" });
    expect(r.returningVisitors).toBe(1);
    const pages = app.db.query("SELECT pages FROM visitor_visit WHERE visitor = ? ORDER BY id").all(id) as { pages: string }[];
    expect(pages.map((p) => JSON.parse(p.pages))).toEqual([["/"], ["/plans"]]);
    expect(probeVisitors(app.db, 30, T0 + 4 * DAY, r).agrees).toBe(true);
  });

  test("a cookie-less repeat from the same network and browser is probable, and is not merged with a cookie id", async () => {
    wipe();
    await beacon();
    await beacon();
    const rows = app.db.query("SELECT id, kind, visits FROM visitor").all() as { id: string; kind: string; visits: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("probable");
    expect(rows[0]!.id.startsWith("p")).toBe(true);
    // Two views within 30 minutes are one visit; the probable row still reads "probable".
    const r = visitorsReport(app.db, 30, Date.now());
    expect(r.newVisitors).toBe(1);
    noteVisitor(app.db, { id: rows[0]!.id, kind: "probable", path: "/", ref: "", step: 0, at: Date.now() + 2 * DAY });
    expect(visitorsReport(app.db, 30, Date.now() + 2 * DAY).returning[0]).toMatchObject({ probable: true, visits: 2 });
    // A cookie arriving is a different visitor.
    await beacon({ cookie: `forge_visitor=${mintId(key).value}` });
    expect(count()).toBe(2);
  });

  test("only a cookie this forge signed is accepted: invented ids do not make rows", async () => {
    setReturning(app.db, true, "u");
    wipe();
    const real = mintId(key);
    expect(cookieId(`forge_visitor=${real.value}`, key)).toBe(real.id);
    expect(cookieId(`forge_visitor=${real.value}`, Buffer.from("another forge's key"))).toBeUndefined();
    expect(cookieId(`forge_visitor=${real.id}.${"0".repeat(32)}`, key)).toBeUndefined();
    expect(cookieId(`forge_visitor=${real.id}`, key)).toBeUndefined();
    for (let i = 0; i < 20; i++) {
      const invented = `c${i.toString(16).padStart(32, "0")}.${"a".repeat(32)}`;
      const res = await beacon({ cookie: `forge_visitor=${invented}` });
      expect(res.status).toBe(204);
    }
    // All twenty are one cookie-less probable visitor; none is a cookie row, and a fresh cookie is offered.
    const rows = app.db.query("SELECT kind FROM visitor").all() as { kind: string }[];
    expect(rows).toEqual([{ kind: "probable" }]);
  });

  test("a day takes at most the cap of new visitors; known visitors still count", () => {
    wipe();
    const at = T0;
    const first = mintId(key).id;
    expect(noteVisitor(app.db, { id: first, kind: "cookie", path: "/", ref: "", step: 0, at }, 2)).toBe(true);
    expect(noteVisitor(app.db, { id: mintId(key).id, kind: "cookie", path: "/", ref: "", step: 0, at }, 2)).toBe(true);
    expect(noteVisitor(app.db, { id: mintId(key).id, kind: "cookie", path: "/", ref: "", step: 0, at }, 2)).toBe(false);
    expect(count()).toBe(2);
    expect(noteVisitor(app.db, { id: first, kind: "cookie", path: "/x", ref: "", step: 0, at: at + 1000 }, 2)).toBe(true);
    // The next day has its own allowance.
    expect(noteVisitor(app.db, { id: mintId(key).id, kind: "cookie", path: "/", ref: "", step: 0, at: at + DAY }, 2)).toBe(true);
    expect(count()).toBe(3);
  });

  test("the terminal shows the same figures to an admin only, and its switch is the one the page reads", () => {
    wipe();
    setReturning(app.db, false, "u");
    const admin = { db: app.db, user: { id: "u", isAdmin: true, kind: "human" } } as unknown as Session;
    const other = { db: app.db, user: { id: "v", isAdmin: false, kind: "human" } } as unknown as Session;
    expect(returningLines(admin)[0]!.title).toContain("Off");
    setReturning(app.db, true, "u");
    const { id } = mintId(key);
    noteVisitor(app.db, { id, kind: "cookie", path: "/", ref: "news.example", step: 1, at: Date.now() - DAY });
    noteVisitor(app.db, { id, kind: "cookie", path: "/", ref: "", step: 1, at: Date.now() });
    const lines = returningLines(admin);
    expect(lines[0]!.title).toContain("1 returning");
    expect(lines.some((l) => l.title.startsWith(id.slice(0, 9)))).toBe(true);
    expect(returningLines(other)).toEqual([]);
  });

  test("a different browser or network is a different probable visitor, and a forged cookie is ignored", () => {
    const h = (ua: string) => new Headers({ "user-agent": ua, "accept-language": "en" });
    const a = probableId("s", h(CHROME), "203.0.113.5");
    expect(probableId("s", h(CHROME), "203.0.113.200")).toBe(a);
    expect(probableId("s", h(CHROME), "203.0.114.5")).not.toBe(a);
    expect(probableId("s", h(CHROME.replace("Chrome/120", "Chrome/121")), "203.0.113.5")).not.toBe(a);
    expect(probableId("t", h(CHROME), "203.0.113.5")).not.toBe(a);
    expect(cookieId("forge_visitor=../../etc", key)).toBeUndefined();
    expect(prefixOf("203.0.113.5")).toBe("203.0.113/24");
    expect(prefixOf("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1/48");
    expect(browserOf(CHROME)).toBe("chrome/120");
    expect(osOf(CHROME)).toBe("windows");
  });

  test("Sec-GPC and DNT get no cookie and no row, a scraper gets no id", async () => {
    wipe();
    for (const headers of [{ "sec-gpc": "1" }, { dnt: "1" }]) {
      const res = await beacon(headers);
      expect(res.status).toBe(204);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    const bot = await beacon({ "user-agent": "Googlebot/2.1 (+http://www.google.com/bot.html)" });
    expect(bot.headers.get("set-cookie")).toBeNull();
    const none = await beacon({ "user-agent": "" });
    expect(none.headers.get("set-cookie")).toBeNull();
    expect(count()).toBe(0);
    expect(count("visitor_visit")).toBe(0);
  });

  test("the visitor who starts a forge is linked to it, with the visits that led there", () => {
    wipe();
    const { id, value } = mintId(key);
    noteVisitor(app.db, { id, kind: "cookie", path: "/", ref: "news.example", step: 1, at: Date.now() - 6 * DAY });
    noteVisitor(app.db, { id, kind: "cookie", path: "/agents", ref: "", step: 1, at: Date.now() - 3 * DAY });
    noteVisitor(app.db, { id, kind: "cookie", path: "/spawn", ref: "", step: 2, at: Date.now() });
    linkRequestVisitor(app, new Request(base, { headers: { cookie: `forge_visitor=${value}` } }), "acme", "started");
    expect(linkVisitor(app.db, id, "other", "paid", Date.now())).toBe(false);
    const led = visitorsReport(app.db, 30, Date.now()).led[0]!;
    expect(led).toMatchObject({ forge: "acme", step: "started a forge", firstRef: "news.example" });
    expect(led.visits).toHaveLength(3);
    linkRequestVisitor(app, new Request(base, { headers: { cookie: `forge_visitor=${value}`, "sec-gpc": "1" } }), "acme", "paid");
    expect(visitorsReport(app.db, 30, Date.now()).led[0]!.step).toBe("started a forge");
    linkRequestVisitor(app, new Request(base, { headers: { cookie: `forge_visitor=${value}` } }), "acme", "paid");
    expect(visitorsReport(app.db, 30, Date.now()).led[0]!.step).toBe("paid");
  });

  test("rows past 13 months are removed, newer ones kept", () => {
    wipe();
    const now = Date.now();
    noteVisitor(app.db, { id: mintId(key).id, kind: "cookie", path: "/", ref: "", step: 0, at: now - KEEP_MS - DAY });
    noteVisitor(app.db, { id: mintId(key).id, kind: "cookie", path: "/", ref: "", step: 0, at: now - 30 * DAY });
    expect(purgeVisitors(app.db, now)).toBe(1);
    expect(count()).toBe(1);
    expect(count("visitor_visit")).toBe(1);
  });

  test("no raw address or full user agent is in the store", async () => {
    wipe();
    await fetch(`${base}/_measure`, {
      method: "POST",
      headers: { origin: base, "user-agent": `${CHROME} SecretMarker`, "x-forwarded-for": "198.51.100.77" },
      body: JSON.stringify({ path: "/", ttfb: 40, load: 300, lcp: 250, inp: 80, cls: 0.02 }),
    });
    expect(count()).toBe(1);
    const dump = JSON.stringify([
      app.db.query("SELECT * FROM visitor").all(),
      app.db.query("SELECT * FROM visitor_visit").all(),
      app.db.query("SELECT * FROM visitor_salt").all(),
    ]);
    for (const needle of ["SecretMarker", "Mozilla", "198.51.100", "127.0.0.1", "203.0.113"]) expect(dump).not.toContain(needle);
  });

  test("the privacy page says what is kept, and the visitors API is for admins only", async () => {
    const page = await (await fetch(`${base}/privacy`)).text();
    expect(page).toContain("13 months");
    expect(page).toContain("never leaves this forge");
    expect([401, 404]).toContain((await fetch(`${base}/api/v1/admin/traffic/visitors?days=30`)).status);
  });

  test("an admin reads the same figures from the API and the Traffic page, and flips the setting from it", async () => {
    const made = await createUser(app.db, { origin: "seed", trusted: true, username: "ada", email: "ada@forge.local", password: "correct-horse-battery", isAdmin: true });
    if (!made.ok) throw new Error(made.error);
    const cookie = `forge_session=${createSession(app.db, made.value.id).token}`;
    wipe();
    setReturning(app.db, true, "u");
    const { id } = mintId(key);
    noteVisitor(app.db, { id, kind: "cookie", path: "/", ref: "news.example", step: 1, at: Date.now() - DAY });
    noteVisitor(app.db, { id, kind: "cookie", path: "/", ref: "", step: 1, at: Date.now() });
    const api = (await (await fetch(`${base}/api/v1/admin/traffic/visitors?days=30`, { headers: { cookie } })).json()) as {
      returning: { id: string; visits: number }[];
      returning_visitors: number;
      probe: { agrees: boolean };
    };
    expect(api.returning_visitors).toBe(1);
    expect(api.returning[0]).toMatchObject({ id: id.slice(0, 9), visits: 2 });
    expect(api.probe.agrees).toBe(true);
    const page = await (await fetch(`${base}/settings/traffic`, { headers: { cookie } })).text();
    expect(page).toContain(id.slice(0, 9));
    expect(page).toContain("news.example");
    const off = await fetch(`${base}/settings/traffic/returning`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, origin: base, "content-type": "application/x-www-form-urlencoded" },
      body: "returning=off",
    });
    expect(off.status).toBe(303);
    expect(getReturning(app.db)).toBe(false);
    const cross = await fetch(`${base}/settings/traffic/returning`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" },
      body: "returning=on",
    });
    expect(cross.status).not.toBe(303);
    expect(getReturning(app.db)).toBe(false);
  });
});
