/**
 * GET /api/v1/repos/:owner/:name/statement and the print page under the
 * app's settings (#508): a month built from the meter, the storage samples
 * and the crew ledger is billed at the list prices and margin; the JSON and
 * the CSV agree; another repository's use never shows; someone who does not
 * administer the repository is told 404; a month not YYYY-MM is refused.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { closeAwake, openAwake, recordStorage } from "../src/core/meter.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { recordUsage } from "../src/core/usage.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { getPrices, setEconomics, setPrices } from "../src/settings/economics.ts";
import { utilities } from "../src/web/style/base.ts";

describe("statement", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let notes: Repo;
  let other: Repo;

  const login = async (username: string) => {
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: new URLSearchParams({ username, password: "a-good-passphrase" }),
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  };
  const get = (token: string, query: string, repo = "notes", owner = "alice") =>
    fetch(`${servers.url}/api/v1/repos/${owner}/${repo}/statement${query}`, {
      headers: { authorization: `Bearer ${token}` },
    });
  const spend = (repo: Repo, usd: number, at: string) =>
    recordUsage(app.db, {
      runId: null,
      repoId: repo.id,
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

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-statement-"));
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

    // October 2026, by hand: 100 awake-hours over two environments, one of
    // them on cloud; 3 GB-months (3 GB held for 730 h); $57.10 of crew.
    openAwake(app.db, { repoId: notes.id, env: "production", placement: "owned", at: "2026-10-02T00:00:00.000Z" });
    closeAwake(app.db, { repoId: notes.id, env: "production", at: "2026-10-05T12:00:00.000Z" }); // 84 h
    openAwake(app.db, { repoId: notes.id, env: "pr-1", placement: "cloud", at: "2026-10-31T08:00:00.000Z" });
    closeAwake(app.db, { repoId: notes.id, env: "pr-1", at: "2026-11-01T02:00:00.000Z" }); // 16 h in October, 2 in November
    for (let h = 0; h < 730; h++)
      recordStorage(app.db, {
        repoId: notes.id,
        dataBytes: 2e9,
        repoBytes: 1e9,
        at: new Date(Date.parse("2026-10-01T00:00:00.000Z") + h * 3_600_000).toISOString(),
      });
    spend(notes, 50, "2026-10-10T00:00:00.000Z");
    spend(notes, 7.1, "2026-10-31T23:59:59.000Z");
    spend(notes, 99, "2026-11-01T00:00:00.000Z"); // November's
    spend(other, 1000, "2026-10-10T00:00:00.000Z"); // another app's
    openAwake(app.db, { repoId: other.id, env: "production", placement: "owned", at: "2026-10-01T00:00:00.000Z" });
    closeAwake(app.db, { repoId: other.id, env: "production", at: "2026-10-20T00:00:00.000Z" });

    setPrices(app.db, { ...getPrices(app.db), awakePriceHourCents: 10, storagePriceGbMonthCents: 25, cloudHourCents: 999 }, alice.id);
    setEconomics(app.db, { position: 50, marginPct: 20 }, alice.id);
  });
  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a hand-built month matches to the cent, and the CSV agrees with the JSON", async () => {
    const token = createToken(app.db, alice.id, "t", "ro").token;
    const res = await get(token, "?month=2026-10");
    expect(res.status).toBe(200);
    const s = (await res.json()) as {
      month: string;
      total: number;
      lines: { what: string; quantity: number; unit: string; price: number; amount: number }[];
    };
    expect(s.month).toBe("2026-10");
    // 100 h × $0.10 + 3 GB-months × $0.25 + $57.10 + 20% × $57.10 = 10 + 0.75 + 57.10 + 11.42.
    expect(s.lines.map((l) => [l.quantity, l.price, l.amount])).toEqual([
      [100, 0.1, 10],
      [3, 0.25, 0.75],
      [57.1, 1, 57.1],
      [57.1, 0.2, 11.42],
    ]);
    expect(s.total).toBe(79.27);

    const csv = await get(token, "?month=2026-10&format=csv");
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.headers.get("content-disposition")).toContain("alice-notes-2026-10.csv");
    const rows = (await csv.text()).trimEnd().split("\r\n").map((r) => r.split(","));
    expect(rows.length).toBe(s.lines.length + 2);
    s.lines.forEach((l, i) => {
      const r = rows[i + 1]!;
      expect([r[2], Number(r[3]), r[4], Number(r[5]), Number(r[6])]).toEqual([l.what, l.quantity, l.unit, l.price, l.amount]);
    });
    expect(Number(rows.at(-1)![6])).toBe(s.total);

    const byAccept = await fetch(`${servers.url}/api/v1/repos/alice/notes/statement?month=2026-10`, {
      headers: { authorization: `Bearer ${token}`, accept: "text/csv" },
    });
    expect(byAccept.headers.get("content-type")).toContain("text/csv");
  });

  test("margin 0 bills crew spend at cost", async () => {
    setEconomics(app.db, { position: 50, marginPct: 0 }, alice.id);
    try {
      const token = createToken(app.db, alice.id, "t", "ro").token;
      const s = (await (await get(token, "?month=2026-10")).json()) as { total: number; lines: { amount: number }[] };
      expect(s.lines[2]!.amount).toBe(57.1);
      expect(s.lines[3]!.amount).toBe(0);
      expect(s.total).toBe(67.85);
    } finally {
      setEconomics(app.db, { position: 50, marginPct: 20 }, alice.id);
    }
  });

  test("someone who does not administer the repository is told 404, and no token is 404", async () => {
    const token = createToken(app.db, bob.id, "t", "ro").token;
    expect((await get(token, "?month=2026-10")).status).toBe(404);
    expect((await fetch(`${servers.url}/api/v1/repos/alice/notes/statement`)).status).toBe(404);
    const page = await fetch(`${servers.url}/alice/notes/settings/app/statement`, { headers: { cookie: await login("bob") } });
    expect(page.status).toBe(404);
  });

  test("a month that is not YYYY-MM, or a format not json or csv, is refused", async () => {
    const token = createToken(app.db, alice.id, "t", "ro").token;
    for (const q of ["?month=2026-13", "?month=26-10", "?month=2026-10-01"]) {
      const res = await get(token, q);
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: string }).error).toBe("bad_month");
    }
    expect((await get(token, "?format=xml")).status).toBe(422);
  });

  test("the print page shows the lines and the total, escaped, with the security floor", async () => {
    const res = await fetch(`${servers.url}/alice/notes/settings/app/statement?month=2026-10`, {
      headers: { cookie: await login("alice") },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBeTruthy();
    const text = await res.text();
    expect(text).toContain("Statement for alice/notes, 2026-10");
    expect(text).toContain("Margin on crew spend (20%)");
    expect(text).toMatch(/data-total>\$79\.27</);
    // Printing alone is the shared stylesheet's rule, not page-inline CSS.
    expect(text).toContain("data-print-alone");
    expect(text).not.toMatch(/<style[^>]*>[^<]*settings-nav/);
    expect(utilities).toMatch(/@media print[\s\S]*body:has\(\[data-print-alone\]\)[^{]*\.settings-nav/);
    expect(text).toContain("/api/v1/repos/alice/notes/statement?month=2026-10&format=csv");
    const bad = await fetch(`${servers.url}/alice/notes/settings/app/statement?month=%3Cb%3E`, {
      headers: { cookie: await login("alice") },
    });
    expect(bad.status).toBe(422);
    expect(await bad.text()).not.toContain("<b>");
  });

  test("the app's settings link to the statement", async () => {
    const res = await fetch(`${servers.url}/alice/notes/settings/app`, { headers: { cookie: await login("alice") } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('href="/alice/notes/settings/app/statement"');
  });
});
