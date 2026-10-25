/**
 * A GET /api/v1 read names its Server-Timing phases (#5248). Every GET route of
 * `apiRoutes` is read from the router's own table and called with a fixture's
 * names filled in; a route that answers 200 without a `session` phase fails
 * unless `UNTIMED` names it with the reason or the issue that will time it.
 * The list only shrinks: removing an entry is how an issue that adds phases
 * proves itself, and a stale entry fails the second test.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createIssue } from "../src/core/issues.ts";
import { apiRoutes } from "../src/http/api.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

/** Routes that answer 200 without a `session` phase → why. */
const UNTIMED: Record<string, string> = {
  "/api/v1/repos/:owner/:name/map": "untimed read today: answers without a session phase",
  "/metrics": "Prometheus text exposition, scraped by token; not a page read",
};

const FILL: Record<string, string> = {
  owner: "alice", username: "alice", name: "notes", number: "1", org: "alice",
  slug: "main", id: "1", team: "core", scope: "alice", job: "1", oid: "0", env: "prod",
};

const getPatterns = (): string[] => {
  const seen: string[] = [];
  const spy = { add(method: string, pattern: string) { if (method === "GET") seen.push(pattern); return spy; } };
  apiRoutes(spy as never);
  return [...new Set(seen)];
};

let dataDir = "";
let app: App, servers: Servers, bearer = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-timing-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  const made = await createRepo(app, admin.value, { name: "notes", visibility: "public", description: "" });
  if (!made.ok) throw new Error(String(made.error));
  createIssue(app.db, { repoId: made.value.id, title: "one", body: "b", authorId: admin.value.id });
  const minted = await fetch(`${servers.url}/api/v1/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adminConfirm: true, username: "alice", password: "correct-horse-battery", name: "cli", scope: "admin" }),
  });
  bearer = ((await minted.json()) as { token: string }).token;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function timed(pattern: string): Promise<{ status: number; session: boolean }> {
  const path = pattern.replace(/:([a-z_]+)/g, (_, k: string) => FILL[k] ?? "x").replace(/\*[a-z_]+/, "x");
  const res = await fetch(`${servers.url}${path}`, { headers: { authorization: `Bearer ${bearer}` }, redirect: "manual" });
  await res.body?.cancel();
  const phases = (res.headers.get("server-timing") ?? "").split(",").map((p) => p.trim().split(";")[0]);
  return { status: res.status, session: phases.includes("session") };
}

test("no GET route answers 200 without a session phase unless the allowlist names it", async () => {
  const untimed: string[] = [];
  for (const pattern of getPatterns()) {
    const r = await timed(pattern);
    if (r.status === 200 && !r.session) untimed.push(pattern);
  }
  expect(untimed.filter((p) => !(p in UNTIMED))).toEqual([]);
});

test("an allowlisted route that now names session leaves the list", async () => {
  const patterns = new Set(getPatterns());
  const stale: string[] = [];
  for (const [pattern, why] of Object.entries(UNTIMED)) {
    expect(why.length).toBeGreaterThan(0);
    if (!patterns.has(pattern)) { stale.push(pattern); continue; }
    const r = await timed(pattern);
    if (r.status !== 200 || r.session) stale.push(pattern);
  }
  expect(stale).toEqual([]);
});
