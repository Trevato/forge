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
  "/metrics": "Prometheus text exposition, scraped by token; not a page read",
};

/**
 * Routes the walk does not request → why. The board routes spawn git against a
 * board repository the fixture lacks: they 5xx on it, and on a loaded machine
 * the spawn is the slow request. Any other 429/5xx fails the walk.
 */
const UNEXERCISED: Record<string, string> = {
  "/api/v1/boards/:slug": "the fixture has no board repository to spawn git in",
  "/api/v1/boards/:slug/panels/:id": "the fixture has no board repository to spawn git in",
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

/** One request's whole allowance: a route slower than this is the finding, not the machine. */
const REQUEST_MS = 5_000;
const BATCH = 8;

type Answer = { status: number; session: boolean; ms: number };

async function once(pattern: string): Promise<Answer> {
  const path = pattern.replace(/:([a-z_]+)/g, (_, k: string) => FILL[k] ?? "x").replace(/\*[a-z_]+/, "x");
  const t0 = performance.now();
  const res = await fetch(`${servers.url}${path}`, {
    headers: { authorization: `Bearer ${bearer}` },
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_MS),
  });
  await res.body?.cancel();
  const phases = (res.headers.get("server-timing") ?? "").split(",").map((p) => p.trim().split(";")[0]);
  return { status: res.status, session: phases.includes("session"), ms: Math.round(performance.now() - t0) };
}

/** Status 0 is a request that outlived REQUEST_MS: the slow route is the finding. Any other error is the test's own and propagates. Nothing is asked twice: a 429 or 5xx is the finding. */
async function timed(pattern: string): Promise<Answer> {
  const t0 = performance.now();
  try {
    return await once(pattern);
  } catch (e) {
    if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
      return { status: 0, session: false, ms: Math.round(performance.now() - t0) };
    }
    throw e;
  }
}

/** Routes walked: those the fixture can exercise. Requests run in batches, so the walk's ceiling is batches x REQUEST_MS. */
const walked = (): string[] => getPatterns().filter((p) => !(p in UNEXERCISED));
const WALK_MS = Math.ceil(walked().length / BATCH) * REQUEST_MS + 5_000;

test("no GET route answers 200 without a session phase unless the allowlist names it", async () => {
  const patterns = walked();
  const results: Answer[] = [];
  for (let i = 0; i < patterns.length; i += BATCH) {
    results.push(...(await Promise.all(patterns.slice(i, i + BATCH).map((p) => timed(p)))));
  }
  // A throttled or failing route is not a route that was checked.
  // Each finding names its pattern, status (0 = timed out) and elapsed ms, so a red run says which route.
  const unchecked = patterns
    .map((p, i) => `${p} -> ${results[i]!.status} in ${results[i]!.ms}ms`)
    .filter((_, i) => results[i]!.status === 0 || results[i]!.status === 429 || results[i]!.status >= 500);
  expect(unchecked).toEqual([]);
  expect(results.filter((r) => r.status === 200).length).toBeGreaterThan(0);
  const untimed = patterns.filter((_, i) => results[i]!.status === 200 && !results[i]!.session);
  expect(untimed.filter((p) => !(p in UNTIMED))).toEqual([]);
}, WALK_MS);

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
