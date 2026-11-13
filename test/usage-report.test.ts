/** The usage page lists every known route, unused ones first; `usage` is an admin-only boards source (#1565). */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { hourOf } from "../src/core/usage_count.ts";
import { routeUsage } from "../src/core/usage_report.ts";
import { buildApiRouter, buildRouter, serve, type Servers } from "../src/http/server.ts";

let dir: string;
let app: App;
let servers: Servers;
const tok: Record<string, string> = {};
const now = new Date("2026-10-16T12:30:00Z");
const ago = (days: number) => hourOf(new Date(now.getTime() - days * 86_400_000));

function seed(hour: string, pattern: string, role: string, surface: string, n: number) {
  app.db.run(
    "INSERT INTO usage_count (hour, pattern, method, status, role, surface, n) VALUES (?, ?, 'GET', '2xx', ?, ?, ?)",
    [hour, pattern, role, surface, n],
  );
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-usage-report-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, adminIfFirst?: boolean) => {
    const r = await createUser(app.db, {
      origin: "seed",
      trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", ...(adminIfFirst ? { adminIfFirst } : {}),
    });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  tok.admin = createToken(app.db, (await mk("alice", true)).id, "t", "admin").token;
  const carol = await mk("carol");
  app.db.query("UPDATE user SET is_admin = 1, is_agent = 1 WHERE id = ?").run(carol.id);
  tok.carol = createToken(app.db, carol.id, "t", "admin").token;
  tok.bob = createToken(app.db, (await mk("bob")).id, "t", "admin").token;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("an unused route is first, with its last use or never; used ones follow by count", () => {
  seed(ago(1), "/busy", "user", "web", 5);
  seed(ago(1), "/busy", "agent", "api", 2);
  seed(ago(2), "/quiet", "admin", "web", 1);
  seed(ago(45), "/stale", "user", "web", 9); // outside the 30 days
  const rows = routeUsage(app.db, ["/busy", "/quiet", "/stale", "/never"], now);
  expect(rows.map((r) => r.pattern)).toEqual(["/never", "/stale", "/busy", "/quiet"]);
  expect(rows[0]).toMatchObject({ total: 0, last: null });
  expect(rows[1]).toMatchObject({ total: 0, last: ago(45) });
  expect(rows[2]).toMatchObject({ total: 7, roles: { user: 5, agent: 2 }, surfaces: { web: 5, api: 2 } });
});

test("the page lists every pattern both routers know, unused first, and only to an admin", async () => {
  const known = [...buildRouter().patterns(), ...buildApiRouter().patterns()];
  seed(hourOf(new Date()), "/system", "admin", "web", 3);
  const get = (who: string | null) =>
    fetch(`${servers.url}/settings/usage`, { headers: who ? { authorization: `Bearer ${tok[who]}` } : {} });
  const res = await get("admin");
  expect(res.status).toBe(200);
  const text = await res.text();
  for (const p of known) expect(text).toContain(p.replace(/&/g, "&amp;"));
  expect(text.indexOf('data-unused="1"')).toBeGreaterThan(-1);
  expect(text.indexOf('data-unused="1"')).toBeLessThan(text.indexOf('data-unused="0"'));
  expect(text).toContain("never");
  expect((await get("bob")).status).toBe(403);
  expect((await get("carol")).status).toBe(403); // an agent account is never an admin here
  expect(await (await get(null)).text()).not.toContain("Route usage");
});

test("usage is a boards source for an admin and for nobody else", async () => {
  const q = (who: string) =>
    fetch(`${servers.url}/api/v1/boards/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${tok[who]}`, "content-type": "application/json" },
      body: JSON.stringify({ source: "usage", aggregate: "sum", column: "n", groupBy: "pattern" }),
    });
  const ok = await q("admin");
  expect(ok.status).toBe(200);
  const rows = ((await ok.json()) as { rows: { group: string; value: number }[] }).rows;
  expect(rows.find((r) => r.group === "/busy")?.value).toBe(7);
  expect((await q("bob")).status).toBe(403);
  expect((await q("carol")).status).toBe(403); // an admin agent is refused too
});

test("Usage is one page: the four tabs on every tab, Spend admin-only, one sidebar entry", async () => {
  const get = (path: string, who: string) =>
    fetch(`${servers.url}${path}`, { headers: { authorization: `Bearer ${tok[who]}` } });
  for (const [path, current] of [
    ["/settings/spend", "Spend"],
    ["/settings/usage", "Routes"],
    ["/settings/capacity", "Capacity"],
    ["/settings/telemetry", "Telemetry"],
  ] as const) {
    const text = await (await get(path, "admin")).text();
    for (const label of ["Spend", "Routes", "Capacity", "Telemetry"])
      expect(text).toMatch(new RegExp(`href="/settings/[a-z]+"[^>]*>\\s*${label}\\s*</a\\s*>`));
    expect(text).toMatch(new RegExp(`href="${path}"\\s+aria-current="page"[^>]*>\\s*${current}\\s*</a\\s*>`));
    expect(text.match(/data-nav/g) ?? []).not.toHaveLength(0);
    expect(text).not.toMatch(/data-nav[^>]*>[^<]*(<svg[\s\S]*?<\/svg>)?\s*(Capacity|Telemetry)\s*</);
  }
  expect((await get("/settings/spend", "bob")).status).toBe(403);
});
