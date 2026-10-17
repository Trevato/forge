/** Every answered request is counted once, by pattern, role and surface (#1918). */

import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createAgent } from "../src/actions/crew.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { methodOf, roleOf, surfaceOf } from "../src/http/usage_tag.ts";
import { readUsage } from "../src/core/usage_count.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let agentToken: string;
let adminToken: string;
let userToken: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-usage-"));
  app = createApp({ dataDir, port: 0 });
  const root = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!root.ok) throw new Error("user");
  const agent = await createAgent(app, root.value, {
    username: "helper",
    model: "",
    brief: "",
  });
  if (!agent.ok) throw new Error(String(agent.error));
  const bob = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "bob",
    email: "bob@forge.local",
    password: "a-good-passphrase",
  });
  if (!bob.ok) throw new Error("user");
  adminToken = createToken(app.db, root.value.id, "t", "ro").token;
  userToken = createToken(app.db, bob.value.id, "t", "ro").token;
  agentToken = createToken(app.db, agent.value.user.id, "t", "ro").token;
});

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("three ids on one route are one row; an agent's API call is agent/api; strangers share one pattern", async () => {
  servers = await serve(app);
  for (const n of [1, 2, 3])
    await fetch(`${servers.url}/api/v1/repos/alice/none/issues/${n}`, {
      headers: { authorization: `Bearer ${agentToken}` },
    });
  const miss = await fetch(`${servers.url}/api/v1/nothing/${crypto.randomUUID()}`);
  await fetch(`${servers.url}/no/such/${crypto.randomUUID()}/path/x/y`);
  // Every response keeps the floor.
  expect(miss.headers.get("x-content-type-options")).toBe("nosniff");

  servers.stop();
  const rows = readUsage(app.db, "");
  const issue = rows.filter(
    (r) => r.pattern === "/api/v1/repos/:owner/:name/issues/:number",
  );
  expect(issue).toHaveLength(1);
  expect(issue[0]).toMatchObject({ n: 3, role: "agent", surface: "api", method: "GET" });
  const unmatched = rows.filter((r) => r.pattern === "(unmatched)");
  expect(unmatched.reduce((sum, r) => sum + r.n, 0)).toBeGreaterThanOrEqual(2);
  expect(rows.some((r) => r.pattern.includes("nothing"))).toBe(false);
});

test("health routes, the mcp surface, roles and a stranger's method are each counted, and nothing logs", async () => {
  servers = await serve(app);
  const warn = spyOn(app.log, "warn");
  await fetch(`${servers.url}/healthz`);
  await fetch(`${servers.url}/readyz`);
  await fetch(`${servers.url}/mcp`, { method: "POST", body: "{}" });
  await fetch(`${servers.url}/`);
  for (const [token, n] of [[adminToken, 1], [userToken, 2]] as const)
    for (let i = 0; i < n; i++)
      await fetch(`${servers.url}/api/v1/repos/alice/none/issues/1`, {
        headers: { authorization: `Bearer ${token}` },
      });
  await fetch(`${servers.url}/`, { method: "PROPFIND" });
  await fetch(`${servers.url}/x`, { method: "MKCOL" });
  expect(warn).not.toHaveBeenCalled();
  warn.mockRestore();

  servers.stop();
  const rows = readUsage(app.db, "");
  const n = (f: (r: (typeof rows)[number]) => boolean) =>
    rows.filter(f).reduce((sum, r) => sum + r.n, 0);
  expect(n((r) => r.pattern === "/healthz" && r.role === "anon")).toBe(1);
  expect(n((r) => r.pattern === "/readyz")).toBe(1);
  expect(n((r) => r.pattern === "/mcp" && r.surface === "mcp")).toBe(1);
  expect(n((r) => r.pattern === "/" && r.surface === "web" && r.method === "GET")).toBe(1);
  expect(n((r) => r.pattern.endsWith("issues/:number") && r.role === "admin")).toBe(1);
  expect(n((r) => r.pattern.endsWith("issues/:number") && r.role === "user")).toBe(2);
  expect(n((r) => r.method === "OTHER")).toBe(2);
  expect(rows.some((r) => r.method === "PROPFIND" || r.method === "MKCOL")).toBe(false);
});

test("roleOf, surfaceOf and methodOf map as the table expects", () => {
  const who = (kind: "user" | "agent", isAdmin: boolean) =>
    ({ user: { kind, isAdmin }, scope: undefined, via: "token" }) as never;
  expect(roleOf({ user: undefined, scope: undefined, via: "none" })).toBe("anon");
  expect(roleOf(who("user", false))).toBe("user");
  expect(roleOf(who("user", true))).toBe("admin");
  expect(roleOf(who("agent", false))).toBe("agent");
  expect(surfaceOf("/mcp")).toBe("mcp");
  expect(surfaceOf("/api")).toBe("api");
  expect(surfaceOf("/api/v1/x")).toBe("api");
  expect(surfaceOf("/alice/repo")).toBe("web");
  expect(methodOf("GET")).toBe("GET");
  expect(methodOf("PROPFIND")).toBe("OTHER");
});

test("a handler that throws is answered 500 and counted 5xx under its route", async () => {
  servers = await serve(app);
  const real = app.db.query.bind(app.db);
  const broken = spyOn(app.db, "query").mockImplementation(((sql: string) => {
    if (/FROM\s+repo\b/i.test(sql)) throw new Error("disk on fire");
    return real(sql);
  }) as never);
  const res = await fetch(`${servers.url}/api/v1/repos/alice/boom/issues/9`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  broken.mockRestore();
  expect(res.status).toBe(500);
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  servers.stop();
  const row = readUsage(app.db, "").filter((r) => r.status === "5xx");
  expect(row.map((r) => [r.pattern, r.role, r.n])).toEqual([
    ["/api/v1/repos/:owner/:name/issues/:number", "admin", 1],
  ]);
});
