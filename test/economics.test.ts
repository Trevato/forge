/**
 * Settings → Economics and /api/v1/forge/economics (#504): a forge admin who
 * is a person reads and sets the profit slider's position and the margin;
 * the page shows the policy in words; both doors refuse what is not a whole
 * number in range and keep every change; a cross-site form, a non-admin and
 * an agent change nothing.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createAgent } from "../src/actions/crew.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { economicsChanges, getEconomics, getOwnedNodeLabel, getPrices } from "../src/settings/economics.ts";

describe("economics", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;

  const login = async (username: string) => {
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: new URLSearchParams({ username, password: "a-good-passphrase" }),
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  };
  const post = (cookie: string, body: Record<string, string>, origin = servers.url) =>
    fetch(`${servers.url}/settings/economics`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin },
      body: new URLSearchParams(body),
    });
  const api = (token: string, method: string, body?: unknown) =>
    fetch(`${servers.url}/api/v1/forge/economics`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-economics-"));
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
  });
  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a fresh forge stands at 50 with no margin, and the page says what 50 means", async () => {
    expect(getEconomics(app.db)).toEqual({ position: 50, marginPct: 0 });
    const res = await fetch(`${servers.url}/settings/economics`, { headers: { cookie: await login("alice") } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('type="range"');
    expect(text).toContain('name="position"');
    expect(text).toContain("production sleeps after 24 h idle · previews after 30 min · cloud takes work above 85% of owned capacity");
  });

  test("a non-admin, signed in or not, is refused and changes nothing", async () => {
    const bobCookie = await login("bob");
    for (const cookie of [bobCookie, ""]) {
      const got = await fetch(`${servers.url}/settings/economics`, { headers: { cookie }, redirect: "manual" });
      expect(got.status).not.toBe(200);
      expect((await post(cookie, { position: "90", marginPct: "10" })).status).not.toBe(303);
    }
    const bobToken = createToken(app.db, bob.id, "t", "admin").token;
    expect((await api(bobToken, "GET")).status).toBe(404);
    expect((await api(bobToken, "PUT", { position: 90 })).status).toBe(404);
    expect(getEconomics(app.db)).toEqual({ position: 50, marginPct: 0 });
  });

  test("an agent, even one granted admin, cannot move the slider", async () => {
    const made = await createAgent(app, alice, { username: "crew-a", budgetUsd: 1 });
    if (!made.ok) throw new Error(String(made.error));
    const agentId = made.value.user.id;
    app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(agentId);
    const token = createToken(app.db, agentId, "t", "admin").token;
    expect((await api(token, "PUT", { position: 100 })).status).toBe(404);
    expect(getEconomics(app.db).position).toBe(50);
  });

  test("the form sets both numbers, same-origin only, and keeps each change", async () => {
    const cookie = await login("alice");
    const crossSite = await post(cookie, { position: "75", marginPct: "20" }, "https://evil.example");
    expect(crossSite.status).toBe(403);
    expect(getEconomics(app.db)).toEqual({ position: 50, marginPct: 0 });

    const saved = await post(cookie, { position: "75", marginPct: "20" });
    expect(saved.status).toBe(303);
    expect(getEconomics(app.db)).toEqual({ position: 75, marginPct: 20 });
    const page = await (await fetch(`${servers.url}/settings/economics`, { headers: { cookie } })).text();
    expect(page).toContain("production sleeps after 4 days idle · previews after 12 h 15 min · cloud takes work above 72.5% of owned capacity");

    // Saving the same numbers again keeps no second change.
    await post(cookie, { position: "75", marginPct: "20" });
    const changes = economicsChanges(app.db);
    expect(changes.map((c) => [c.key, c.from, c.to, c.actorName]).sort()).toEqual([
      ["marginPct", "0", "20", "alice"],
      ["position", "50", "75", "alice"],
    ]);
  });

  test("the form refuses a fraction, a word or a number out of range", async () => {
    const cookie = await login("alice");
    for (const body of [{ position: "50.5" }, { position: "abc" }, { position: "101" }, { position: "-1" }, { position: "10", marginPct: "501" }]) {
      const res = await post(cookie, { marginPct: "20", ...body });
      expect(res.status).toBe(303);
      expect(getEconomics(app.db)).toEqual({ position: 75, marginPct: 20 });
    }
  });

  test("the API reads and sets with the same validation", async () => {
    const token = createToken(app.db, alice.id, "t", "admin").token;
    const read = await api(token, "GET");
    expect(read.status).toBe(200);
    const got = (await read.json()) as Record<string, unknown>;
    expect(got.position).toBe(75);
    expect(got.marginPct).toBe(20);
    expect(got.policy).toEqual({
      sleepAfterMs: { production: 345_600_000, preview: 44_100_000 },
      idlePullMs: 432_000_000,
      spillAtOwnedUse: 0.725,
    });

    for (const [body, code] of [
      [{ position: 100.5 }, "bad_position"],
      [{ position: "100" }, null],
      [{ position: 101 }, "bad_position"],
      [{ position: null }, "bad_position"],
      [{ marginPct: -5 }, "bad_margin"],
    ] as const) {
      const res = await api(token, "PUT", body);
      if (code === null) {
        expect(res.status).toBe(200);
        continue;
      }
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: string }).error).toBe(code);
    }
    expect(getEconomics(app.db)).toEqual({ position: 100, marginPct: 20 });

    const set = await api(token, "PUT", { position: 0 });
    expect(set.status).toBe(200);
    const after = (await set.json()) as { position: number; marginPct: number; policy: { spillAtOwnedUse: number } };
    expect(after.position).toBe(0);
    expect(after.marginPct).toBe(20);
    expect(after.policy.spillAtOwnedUse).toBe(1);

    const ro = createToken(app.db, alice.id, "r", "ro").token;
    expect((await api(ro, "PUT", { position: 50 })).status).toBe(403);
    expect(getEconomics(app.db).position).toBe(0);
  });

  test("prices: the form and the API set them in dollars, refuse a third decimal or a sign, and the page costs the month", async () => {
    const cookie = await login("alice");
    expect(getPrices(app.db)).toEqual({ ownedMonthCents: 0, ownedSlots: 0, cloudHourCents: 0, storageGbMonthCents: 0 });
    const prices = { ownedMonthUsd: "300", ownedSlots: "40", cloudHourUsd: "0.05", storageGbMonthUsd: "0.02" };
    expect((await post(cookie, prices, "https://evil.example")).status).toBe(403);
    expect(getPrices(app.db).ownedMonthCents).toBe(0);

    // The prices form carries no position: it keeps what stands.
    const before = getEconomics(app.db);
    expect((await post(cookie, prices)).status).toBe(303);
    expect(getPrices(app.db)).toEqual({ ownedMonthCents: 30_000, ownedSlots: 40, cloudHourCents: 5, storageGbMonthCents: 2 });
    expect(getEconomics(app.db)).toEqual(before);
    expect(economicsChanges(app.db).filter((c) => c.key === "ownedMonthCents").map((c) => [c.from, c.to])).toEqual([["0", "30000"]]);

    for (const bad of [{ ownedMonthUsd: "-1" }, { cloudHourUsd: "0.001" }, { storageGbMonthUsd: "abc" }, { ownedSlots: "1.5" }]) {
      await post(cookie, { ...prices, ...bad, ownedMonthUsd: bad.ownedMonthUsd ?? "999" });
      expect(getPrices(app.db).ownedMonthCents).toBe(30_000);
    }

    // No awake time, storage or crew yet this month: the cost is the box
    // amortised over the month so far, at most the whole box.
    const page = await (await fetch(`${servers.url}/settings/economics`, { headers: { cookie } })).text();
    expect(page).toContain('name="ownedMonthUsd"');
    expect(page).toContain('value="300.00"');
    expect(page).toContain("$/awake-hour");
    expect(page).toContain("$/GB-month");
    expect(page).toContain("Per app-slot ($/month)");
    expect(page).toContain("$7.50");
    // Said once: the form holds the prices; the formulas live in docs/features/economics.md.
    expect(page).not.toContain("/awake-hour on cloud");
    expect(page).not.toContain("GB-hours ÷");

    const token = createToken(app.db, alice.id, "t2", "admin").token;
    const got = (await (await api(token, "GET")).json()) as {
      prices: Record<string, number>;
      month: { from: string; to: string; cost: { owned: number; cloud: number; total: number } };
    };
    expect(got.prices).toEqual({ ownedMonthUsd: 300, ownedSlots: 40, cloudHourUsd: 0.05, storageGbMonthUsd: 0.02 });
    expect(got.month.cost.cloud).toBe(0);
    expect(got.month.cost.owned).toBeGreaterThan(0);
    expect(got.month.cost.owned).toBeLessThanOrEqual(300);
    expect(got.month.cost.total).toBe(got.month.cost.owned);

    const bad = await api(token, "PUT", { cloudHourUsd: 0.055 });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { error: string }).error).toBe("bad_price");
    expect(((await (await api(token, "PUT", { ownedSlots: -1 })).json()) as { error: string }).error).toBe("bad_slots");
    expect((await api(token, "PUT", { cloudHourUsd: 0.1 })).status).toBe(200);
    expect(getPrices(app.db).cloudHourCents).toBe(10);
  });

  test("the owned-node label is a setting: shown with the queue line, set by API and form, validated (#509)", async () => {
    const token = createToken(app.db, alice.id, "t", "admin").token;
    const got = (await (await api(token, "GET")).json()) as { placement: Record<string, unknown> };
    expect(got.placement).toEqual({
      cloudBody: false,
      ownedNodeLabel: "plat.sh/site=vxrail",
      words: "no cloud body: bursts queue",
    });
    for (const bad of ["vxrail", "a b=c", "=x", 7, "plat.sh/site=has space"]) {
      const res = await api(token, "PUT", { ownedNodeLabel: bad });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: string }).error).toBe("bad_label");
    }
    expect(getOwnedNodeLabel(app.db)).toBe("plat.sh/site=vxrail");
    const set = await api(token, "PUT", { ownedNodeLabel: "plat.sh/site=metal-2" });
    expect(set.status).toBe(200);
    expect(((await set.json()) as { placement: { ownedNodeLabel: string } }).placement.ownedNodeLabel).toBe("plat.sh/site=metal-2");

    const cookie = await login("alice");
    const before = getEconomics(app.db);
    await post(cookie, { position: String(before.position), marginPct: String(before.marginPct), ownedNodeLabel: "site=home" });
    expect(getOwnedNodeLabel(app.db)).toBe("site=home");
    // A form without the field keeps the label that stands.
    await post(cookie, { position: String(before.position), marginPct: String(before.marginPct) });
    expect(getOwnedNodeLabel(app.db)).toBe("site=home");
    const page = await (await fetch(`${servers.url}/settings/economics`, { headers: { cookie } })).text();
    // The placement is said once, and the label is the field's value.
    expect(page).toContain("<p data-placement>no cloud body: bursts queue.</p>");
    expect(page).toContain('value="site=home"');
    // Left blank, the field is the default again: no row stands for it.
    await post(cookie, { position: String(before.position), marginPct: String(before.marginPct), ownedNodeLabel: "  " });
    expect(getOwnedNodeLabel(app.db)).toBe("plat.sh/site=vxrail");
    expect(app.db.query("SELECT 1 FROM forge_setting WHERE key = 'placement.owned_node_label'").get()).toBeNull();
    expect(economicsChanges(app.db).filter((c) => c.key === "ownedNodeLabel").map((c) => c.to)).toEqual([
      "plat.sh/site=vxrail",
      "site=home",
      "plat.sh/site=metal-2",
    ]);
    app.db.query("UPDATE forge_setting SET value = 'not a label' WHERE key = 'placement.owned_node_label'").run();
    expect(getOwnedNodeLabel(app.db)).toBe("plat.sh/site=vxrail");
  });

  test("a hand-edited stored value reads as the default, never as itself", () => {
    app.db.query("UPDATE forge_setting SET value = '250' WHERE key = 'economics.position'").run();
    expect(getEconomics(app.db).position).toBe(50);
  });
});
