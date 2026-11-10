/**
 * The money line (#510): the board's cost, revenue and gap for the month
 * and today, worked by hand; the board's revenue is the sum of the apps'
 * statements, to the cent; an app's month card; the thirty-day SVG's
 * points; and the board and app page showing them to those who may see.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { readAppMoney, readForgeMoney, DAYS } from "../src/actions/money.ts";
import { createRepo } from "../src/actions/repos.ts";
import { readStatement } from "../src/actions/statement.ts";
import { createApp as makeAppRecord } from "../src/core/apps.ts";
import { closeAwake, openAwake, usageBetween, usageBins } from "../src/core/meter.ts";
import type { Repo } from "../src/core/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { recordUsage } from "../src/core/usage.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { getPrices, setEconomics, setPrices } from "../src/settings/economics.ts";
import { forgeMoneyLine, moneyChart, signed } from "../src/web/studio/money_line.ts";

const NOW = "2026-11-10T12:00:00.000Z";

describe("money line", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let notes: Repo;
  let other: Repo;

  const spend = (repoId: string, usd: number, at: string) =>
    recordUsage(app.db, {
      runId: null,
      repoId,
      issueId: null,
      agentId: null,
      subscriptionId: null,
      tokensIn: 1,
      tokensOut: 1,
      costUsd: usd,
      wallMs: 1,
      outcome: "ok",
      at,
    } as never);
  const login = async (username: string) => {
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: new URLSearchParams({ username, password: "a-good-passphrase" }),
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  };
  const page = async (cookie: string, path: string) =>
    (await fetch(`${servers.url}${path}`, { headers: { cookie } })).text();

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-money-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    for (const [username, first] of [["alice", true], ["bob", false]] as const) {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!made.ok) throw new Error(made.error);
      if (username === "alice") alice = made.value;
      else bob = made.value;
    }
    const a = await createRepo(app, alice, { name: "notes", visibility: "public" });
    const b = await createRepo(app, alice, { name: "other", visibility: "public" });
    if (!a.ok || !b.ok) throw new Error("repo");
    notes = a.value;
    other = b.value;
    makeAppRecord(app.db, { repoId: notes.id, slug: "notes", access: "public" });
    // A run in its past: the app page shows a running app's rail, not a fresh app's progress.
    createRun(app.db, { repoId: notes.id, kind: "agent", summary: "a past run" });

    // November 2026 to the 10th at noon, by hand:
    // notes: 10 h owned on the 2nd, $5 of crew on the 3rd;
    // other: 20 h cloud on the 5th, $2.50 of crew that day.
    openAwake(app.db, { repoId: notes.id, env: "production", placement: "owned", at: "2026-11-02T00:00:00.000Z" });
    closeAwake(app.db, { repoId: notes.id, env: "production", at: "2026-11-02T10:00:00.000Z" });
    openAwake(app.db, { repoId: other.id, env: "pr-1", placement: "cloud", at: "2026-11-05T00:00:00.000Z" });
    closeAwake(app.db, { repoId: other.id, env: "pr-1", at: "2026-11-05T20:00:00.000Z" });
    spend(notes.id, 5, "2026-11-03T09:00:00.000Z");
    spend(other.id, 2.5, "2026-11-05T09:00:00.000Z");

    setPrices(
      app.db,
      {
        ...getPrices(app.db),
        ownedMonthCents: 30_000,
        cloudHourCents: 5,
        storageGbMonthCents: 2,
        awakePriceHourCents: 10,
        storagePriceGbMonthCents: 25,
      },
      alice.id,
    );
    setEconomics(app.db, { position: 62, marginPct: 20 }, alice.id);
  });
  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the month, today and thirty days match a hand calculation", () => {
    const m = readForgeMoney(app, alice, NOW);
    if (!m.ok) throw new Error(m.error);
    // Revenue: notes 10 h × $0.10 + $5 + 20% = 7.00; other 20 h × $0.10 + $2.50 + 20% = 5.00.
    // Cost: the box for 9.5 of November's 30 days, 300 × 9.5 / 30 = 95.00; cloud 20 h × $0.05 = 1.00;
    // crew 5 + 2.50 = 7.50. Total 103.50; gap 12.00 − 103.50 = −91.50.
    expect(m.value.month).toBe("2026-11");
    expect(m.value.thisMonth).toEqual({ cost: 103.5, revenue: 12, gap: -91.5 });
    // Today is half a day of the box: 300 × 0.5 / 30.
    expect(m.value.today).toEqual({ day: "2026-11-10", cost: 5, revenue: 0, gap: -5 });
    expect(m.value.position).toBe(62);
    expect(m.value.days).toHaveLength(DAYS);
    expect(m.value.days[0]!.day).toBe("2026-10-12");
    // An October day is a 31st of the box: 300 / 31 = 9.677… → 9.68.
    expect(m.value.days[0]).toEqual({ day: "2026-10-12", cost: 9.68, revenue: 0, gap: -9.68 });
    // The 5th: a 30th of the box, an hour of cloud × 20, and $2.50 of crew; revenue other's 5.00.
    expect(m.value.days.find((d) => d.day === "2026-11-05")).toEqual({ day: "2026-11-05", cost: 13.5, revenue: 5, gap: -8.5 });
    // November's days add up to the month.
    const nov = m.value.days.filter((d) => d.day.startsWith("2026-11"));
    expect(Math.round(nov.reduce((s, d) => s + d.revenue, 0) * 100)).toBe(1200);
    expect(Math.round(nov.reduce((s, d) => s + d.cost, 0) * 100)).toBe(10350);
  });

  test("the board's revenue is the sum of the apps' statements, to the cent", () => {
    const m = readForgeMoney(app, alice, NOW);
    if (!m.ok) throw new Error(m.error);
    let cents = 0;
    for (const repo of [notes, other]) {
      const s = readStatement(app, alice, repo, "2026-11", NOW);
      if (!s.ok) throw new Error(s.error);
      cents += Math.round(s.value.total * 100);
    }
    expect(cents).toBe(1200);
    expect(Math.round(m.value.thisMonth.revenue * 100)).toBe(cents);
  });

  test("an app's month: its statement, its cost with its share of the box, and where it was awake", () => {
    const n = readAppMoney(app, alice, notes, NOW);
    if (!n.ok) throw new Error(n.error);
    // All the owned time was notes': the whole 95.00 of box, and its $5 of crew.
    expect(n.value.thisMonth).toEqual({ cost: 100, revenue: 7, gap: -93 });
    expect([n.value.ownedSeconds, n.value.cloudSeconds, n.value.ownedShare]).toEqual([36_000, 0, 1]);
    const o = readAppMoney(app, alice, other, NOW);
    if (!o.ok) throw new Error(o.error);
    // No owned time, no box: 20 h × $0.05 + $2.50.
    expect(o.value.thisMonth).toEqual({ cost: 3.5, revenue: 5, gap: 1.5 });
    expect([o.value.ownedSeconds, o.value.cloudSeconds, o.value.ownedShare]).toEqual([0, 72_000, 0]);
  });

  test("only a forge admin reads the forge's; only the app's admins read the app's", () => {
    expect(readForgeMoney(app, bob, NOW)).toEqual({ ok: false, error: "not_found" });
    expect(readForgeMoney(app, undefined, NOW)).toEqual({ ok: false, error: "not_found" });
    expect(readForgeMoney(app, { ...alice, kind: "agent" } as User, NOW)).toEqual({ ok: false, error: "not_found" });
    expect(readAppMoney(app, bob, notes, NOW)).toEqual({ ok: false, error: "not_found" });
  });

  test("each day's meter bin is what usageBetween says for that day", () => {
    const edges = ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-05", "2026-11-06"].map((d) => `${d}T00:00:00.000Z`);
    const bins = usageBins(app.db, edges, NOW);
    expect(bins).toHaveLength(4);
    bins.forEach((bin, i) => expect(bin).toEqual(usageBetween(app.db, edges[i]!, edges[i + 1]!, NOW)));
  });

  test("the chart: two polylines and the shaded gap, at hand-worked points", () => {
    const svg = moneyChart([
      { day: "2026-11-01", cost: 0, revenue: 0, gap: 0 },
      { day: "2026-11-02", cost: 1, revenue: 2, gap: 1 },
    ]).text;
    // Box 240 × 48, 2 of padding: x 2 and 238; y scale 44 / 2 = 22 per dollar from a baseline at 46.
    expect(svg).toContain('class="money-cost" points="2,46 238,24"');
    expect(svg).toContain('class="money-revenue" points="2,46 238,2"');
    expect(svg).toContain('data-sign="up" points="2,46 238,2 238,24 2,46"');
    expect(svg).toContain('viewBox="0 0 240 48"');
    // All zeros: the same box, flat on the baseline, no bands.
    const flat = moneyChart([
      { day: "2026-11-01", cost: 0, revenue: 0, gap: 0 },
      { day: "2026-11-02", cost: 0, revenue: 0, gap: 0 },
    ]).text;
    expect(flat).toContain('class="money-cost" points="2,46 238,46"');
    expect(flat).not.toContain("<polygon");
    expect([signed(52.66), signed(-3.1), signed(0), signed(-0.001)]).toEqual(["+$52.66", "-$3.10", "$0.00", "$0.00"]);
  });

  test("the board shows the line and the chart to a forge admin, and to nobody else", async () => {
    const html = await page(await login("alice"), "/board");
    expect(html).toContain('class="money-line"');
    expect(html).toContain("This month");
    expect(html).toContain("Economics slider: 62");
    const line = html.match(/<section class="money-line"[\s\S]*?<\/section>/)?.[0] ?? "";
    expect(line.match(/href="\/settings\/economics"/g)?.length).toBe(1);
    expect(html).toContain('<svg\n    class="money-chart"');
    expect(html).toMatch(/class="money-gap num" data-sign="(up|down|even)"/);
    const theirs = await page(await login("bob"), "/board");
    expect(theirs).not.toContain('class="money-line"');
  });

  test("the app page has the month card for its admin, and not for a stranger", async () => {
    const html = await page(await login("alice"), "/alice/notes");
    expect(html).toContain("<h2>This month</h2>");
    expect(html).toContain('href="/alice/notes/settings/app/statement"');
    expect(html).toContain("own server for the month, its share");
    const theirs = await page(await login("bob"), "/alice/notes");
    expect(theirs).not.toContain("<h2>This month</h2>");
  });

  test("a fresh app's page shows its progress, not the month card", async () => {
    const made = await createRepo(app, alice, { name: "fresh", visibility: "public" });
    if (!made.ok) throw new Error("repo");
    makeAppRecord(app.db, { repoId: made.value.id, slug: "fresh", access: "public" });
    const html = await page(await login("alice"), "/alice/fresh");
    expect(html).not.toContain("<h2>This month</h2>");
    expect(await page(await login("alice"), "/alice/notes")).toContain("<h2>This month</h2>");
  });
});

describe("the forge's cost is the apps' costs plus what no app carries", () => {
  test("Σ app costs + the box's unowned share = the board's cost", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-money-sum-"));
    const app = createApp({ dataDir, port: 0 });
    try {
      const made = await createUser(app.db, {
        origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
        password: "a-good-passphrase", adminIfFirst: true,
      });
      if (!made.ok) throw new Error(made.error);
      const alice = made.value;
      const repos: Repo[] = [];
      for (const name of ["a", "b", "c"]) {
        const r = await createRepo(app, alice, { name, visibility: "public" });
        if (!r.ok) throw new Error("repo");
        repos.push(r.value);
      }
      const [a, b, c] = repos as [Repo, Repo, Repo];
      const awake = (repo: Repo, placement: "owned" | "cloud", from: string, to: string) => {
        openAwake(app.db, { repoId: repo.id, env: "production", placement, at: from });
        closeAwake(app.db, { repoId: repo.id, env: "production", at: to });
      };
      // a 6 h owned, b 2 h owned (shares 3/4 and 1/4), c 10 h on cloud and $1 of crew.
      awake(a, "owned", "2026-11-02T00:00:00.000Z", "2026-11-02T06:00:00.000Z");
      awake(b, "owned", "2026-11-03T00:00:00.000Z", "2026-11-03T02:00:00.000Z");
      awake(c, "cloud", "2026-11-04T00:00:00.000Z", "2026-11-04T10:00:00.000Z");
      recordUsage(app.db, {
        runId: null, repoId: c.id, issueId: null, agentId: null, subscriptionId: null,
        tokensIn: 1, tokensOut: 1, costUsd: 1, wallMs: 1, outcome: "ok", at: "2026-11-04T09:00:00.000Z",
      } as never);
      setPrices(app.db, { ...getPrices(app.db), ownedMonthCents: 30_000, cloudHourCents: 5, storageGbMonthCents: 0 }, alice.id);
      const forge = readForgeMoney(app, alice, NOW);
      if (!forge.ok) throw new Error(forge.error);
      const apps = repos.map((r) => {
        const m = readAppMoney(app, alice, r, NOW);
        if (!m.ok) throw new Error(m.error);
        return m.value;
      });
      // By hand: box 300 × 9.5 / 30 = 95.00, split 71.25 (a) and 23.75 (b); c 10 h × $0.05 + $1 = 1.50.
      expect(apps.map((m) => m.thisMonth.cost)).toEqual([71.25, 23.75, 1.5]);
      expect(apps.map((m) => m.ownedShare)).toEqual([0.75, 0.25, 0]);
      // Every owned hour was an app's, so nothing of the box is unowned: the sum is the apps' alone.
      const box = 95;
      const unowned = box * (1 - apps.reduce((s, m) => s + m.ownedShare, 0));
      const sum = apps.reduce((s, m) => s + Math.round(m.thisMonth.cost * 100), 0) + Math.round(unowned * 100);
      expect(unowned).toBe(0);
      expect(forge.value.thisMonth.cost).toBe(96.5);
      expect(Math.round(forge.value.thisMonth.cost * 100)).toBe(sum);
    } finally {
      app.db.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("with no app awake on the forge's own server, the whole box is the forge's alone", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-money-unowned-"));
    const app = createApp({ dataDir, port: 0 });
    try {
      const made = await createUser(app.db, {
        origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
        password: "a-good-passphrase", adminIfFirst: true,
      });
      if (!made.ok) throw new Error(made.error);
      const r = await createRepo(app, made.value, { name: "c", visibility: "public" });
      if (!r.ok) throw new Error("repo");
      openAwake(app.db, { repoId: r.value.id, env: "production", placement: "cloud", at: "2026-11-04T00:00:00.000Z" });
      closeAwake(app.db, { repoId: r.value.id, env: "production", at: "2026-11-04T10:00:00.000Z" });
      setPrices(app.db, { ...getPrices(app.db), ownedMonthCents: 30_000, cloudHourCents: 5, storageGbMonthCents: 0 }, made.value.id);
      const forge = readForgeMoney(app, made.value, NOW);
      const one = readAppMoney(app, made.value, r.value, NOW);
      if (!forge.ok || !one.ok) throw new Error("read");
      // The app pays its cloud alone, 0.50; the box's 95.00 is unowned, so the forge's cost is 95.50.
      expect(one.value.thisMonth.cost).toBe(0.5);
      expect(forge.value.thisMonth.cost).toBe(95.5);
    } finally {
      app.db.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("money line on an empty forge", () => {
  test("the slot is there with zeros, so nothing shifts when figures arrive", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-money-empty-"));
    const app = createApp({ dataDir, port: 0 });
    try {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username: "alice",
        email: "alice@forge.local",
        password: "a-good-passphrase",
        adminIfFirst: true,
      });
      if (!made.ok) throw new Error(made.error);
      setPrices(app.db, { ...getPrices(app.db), ownedMonthCents: 0 }, made.value.id);
      const m = readForgeMoney(app, made.value, NOW);
      if (!m.ok) throw new Error(m.error);
      expect(m.value.thisMonth).toEqual({ cost: 0, revenue: 0, gap: 0 });
      expect(m.value.days).toHaveLength(DAYS);
      const line = forgeMoneyLine(m.value).text;
      expect(line).toContain('data-sign="even" href="/settings/economics" aria-label="Month gap $0.00, open Economics settings">$0.00</a>');
      expect(line).toContain('width="240"');
      expect(line).toContain('height="48"');
    } finally {
      app.db.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
