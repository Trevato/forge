/**
 * One sweep over every route the two routers register, every verb each one
 * takes, held to the security floor (`securityFloor`, src/http/respond.ts)
 * and to the same-origin rule for cookies (#10386).
 *
 * Three passes over one seeded server, each request sent once:
 *
 * 1. Anonymous, each registered (method, pattern), plus the probes and an
 *    unknown path: the floor (Content-Security-Policy, X-Content-Type-Options,
 *    Referrer-Policy) on whatever comes back — 2xx, 3xx, 4xx, 404 and
 *    streamed answers alike. Its mutations are sent from another origin
 *    with the seed's real username and password: none may hand out a
 *    session (login CSRF).
 * 2. Each API pattern with a verb it does not register: 405, its `Allow`
 *    naming what the path does take, and the floor; a studio path's wrong
 *    verb is the not-found page, asked once.
 * 3. Every mutating route, cross-origin, with a live session cookie: 403
 *    before any handler (`originGate`), no Set-Cookie, and the session is
 *    still good afterwards.
 *
 * Every Set-Cookie seen in any pass, and the one a real same-origin sign-in
 * sets, is HttpOnly unless named in `READABLE_COOKIES` with why.
 *
 * Parameters are filled from one seeded user and repository; anything else
 * gets a placeholder, so those routes answer their miss — which must carry
 * the floor as much as a hit. `test/security-floor-routes.test.ts` fills
 * deeper (issues, pulls, runs, apps) for GET, signed in and out.
 *
 * About 1 800 requests, 32 in flight against the one server. The three
 * passes' request loops are timed together and held under 5 s
 * (`SWEEP_CEILING_MS`, #10401); server boot and the seed are not counted.
 * The work is bounded by the route table, one request per (verb, route)
 * and pass.
 *
 * Side effects stay in the scratch FORGE_APP_DATA: the bodies sent are empty
 * or the seed's own credentials, and the cross-origin cookie pass is refused
 * before any handler runs.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createIssue } from "../src/core/issues.ts";
import { createRepo } from "../src/core/repos.ts";
import { createSession, sessionOf } from "../src/core/sessions.ts";
import { buildApiRouter, buildRouter, serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { pool, SWEEP_CEILING_MS, timed } from "./helpers/sweep-clock.ts";

quietLogs();

const USERNAME = "ada";
const PASSWORD = "correct-horse-battery";
const EVIL = "https://evil.example";
const FLOOR = ["content-security-policy", "x-content-type-options", "referrer-policy"] as const;
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Responses allowed to leave without part of the floor → why. Kept empty
 * while every answer carries it: `/healthz`, `/readyz` and the hashed
 * assets all leave through the one door (`answered` in src/http/server.ts)
 * that applies it. A path added here must still be a real exception: the
 * test below fails when a named one carries the full floor after all.
 */
const FLOOR_EXCEPTIONS: Record<string, string> = {};

/**
 * API-router paths whose wrong verb is a plain 404, not a 405 → why. Each
 * still carries the floor; the test fails if one starts answering 405.
 */
const NO_405: Record<string, string> = {
  "/api/v1": "the API root is read-only and answers a write as it always did: no route (`answerGet`, src/http/server.ts)",
  "/api/v1/": "the API root with its slash, the same read-only root as /api/v1",
  "/metrics": "a scraper's path outside /api/, so its miss is the machine-path 404, not the API's 405",
};

/** Cookies a page's own script must read, so not HttpOnly → why. */
const READABLE_COOKIES: Record<string, string> = {};

let dataDir = "";
let app: App;
let servers: Servers;
let session = "";
let token = "";
const fill: Record<string, string> = { owner: USERNAME, name: "notes", username: USERNAME, ref: "main", path: "a.txt" };

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-sweep-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const admin = await seedAdmin(app, { username: USERNAME, email: "ada@forge.local", password: PASSWORD });
  if (!admin.ok) throw new Error(String(admin.error));
  const made = await createRepo(app.db, app.reposRoot, { ownerId: admin.value.id, name: "notes", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  const seeded = await commitToBranch(app, admin.value, made.value, { message: "seed", files: [{ path: "a.txt", content: "a\n" }] });
  if (!seeded.ok) throw new Error(String(seeded.error));
  const issue = createIssue(app.db, { repoId: made.value.id, title: "an issue", body: "b", authorId: admin.value.id });
  if (!issue.ok) throw new Error(String(issue.error));
  fill.number = String(issue.value.number);
  token = createSession(app.db, admin.value.id).token;
  session = `forge_session=${token}`;
}, 30_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

interface Route {
  method: string;
  pattern: string;
  api: boolean;
}

const routes = (): Route[] => {
  const seen = new Set<string>();
  const out: Route[] = [];
  for (const [router, api] of [[buildRouter(), false], [buildApiRouter(), true]] as const)
    for (const { method, pattern } of router.routes()) {
      const key = `${method} ${pattern}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ method, pattern, api });
    }
  return out;
};

const pathFor = (pattern: string): string =>
  pattern.replace(/[:*]([a-z_]+)/g, (_, key: string) => encodeURIComponent(fill[key] ?? "x"));

interface Seen {
  label: string;
  status: number;
  type: string;
  missing: string[];
  cookies: string[];
  allow: string | null;
}

async function send(method: string, path: string, headers: Record<string, string>, body?: string): Promise<Seen> {
  const res = await fetch(`${servers.url}${path}`, {
    method,
    headers: { "accept-encoding": "identity", ...headers },
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
  await res.body?.cancel().catch(() => {});
  return {
    label: `${method} ${path} → ${res.status}`,
    status: res.status,
    type: res.headers.get("content-type") ?? "",
    missing: FLOOR.filter((h) => !res.headers.get(h)),
    cookies: res.headers.getSetCookie(),
    allow: res.headers.get("allow"),
  };
}

const floorGaps = (seen: Seen[]): string[] =>
  seen
    .filter((s) => s.missing.length > 0 && FLOOR_EXCEPTIONS[s.label.split(" ")[1]!] === undefined)
    .map((s) => `${s.label} lacks ${s.missing.join(", ")}`);

const cookieName = (header: string): string => header.slice(0, header.indexOf("="));
const notHttpOnly = (seen: Seen[]): string[] =>
  seen.flatMap((s) =>
    s.cookies
      .filter((c) => !/;\s*httponly\s*(;|$)/i.test(c) && READABLE_COOKIES[cookieName(c)] === undefined)
      .map((c) => `${s.label} sets ${cookieName(c)} without HttpOnly`),
  );

const anonymous: Seen[] = [];
const wrongMethod: Seen[] = [];
/** Milliseconds the three passes' request loops took, summed; boot and seed are not counted. */
let loopMs = 0;

/** Time one pass's request loop and add it to `loopMs`. */
async function lap<T>(loop: () => Promise<T>): Promise<T> {
  const { value, ms } = await timed(loop);
  loopMs += ms;
  return value;
}

test("every registered route and verb, asked anonymously, answers with the floor and hands out no session", async () => {
  // A mutation is sent from another origin with the seed's real username
  // and password, as a page elsewhere could: no route may answer it with a
  // session (login CSRF), whatever it does with the rest.
  const form = new URLSearchParams({ username: USERNAME, password: PASSWORD }).toString();
  const json = JSON.stringify({ username: USERNAME, password: PASSWORD });
  const all = routes();
  anonymous.push(
    ...(await lap(async () => [
      ...(await pool(all, (r) => {
        const path = pathFor(r.pattern);
        if (!MUTATING.has(r.method)) return send(r.method, path, {});
        return r.api
          ? send(r.method, path, { origin: EVIL, "content-type": "application/json" }, json)
          : send(r.method, path, { origin: EVIL, "content-type": "application/x-www-form-urlencoded" }, form);
      })),
      // Plus what answers before any route (the probes) and a path no route claims, studio and API.
      ...(await pool(["/healthz", "/readyz", "/no/such/path/at/all", "/api/v1/no-such-route"], (path) => send("GET", path, {}))),
    ])),
  );
  expect(floorGaps(anonymous)).toEqual([]);
  expect(notHttpOnly(anonymous)).toEqual([]);
  expect(anonymous.filter((s) => s.cookies.some((c) => /^forge_session=[^;]/.test(c))).map((s) => s.label)).toEqual([]);
  // The kinds the floor must hold on were all met, so a seed that stops
  // reaching one is noticed rather than passing vacuously.
  const statuses = [...new Set(anonymous.map((s) => s.status))];
  expect(statuses.some((s) => s >= 200 && s < 300)).toBe(true);
  expect(statuses.some((s) => s >= 300 && s < 400)).toBe(true);
  expect(statuses).toContain(404);
  expect(statuses.some((s) => s >= 400 && s < 500 && s !== 404)).toBe(true);
  expect(anonymous.some((s) => s.type.startsWith("text/event-stream"))).toBe(true);
}, 6_000);

test("an API path asked with a verb it does not take answers 405, naming the ones it does, with the floor", async () => {
  const api = buildApiRouter();
  const methods = new Map<string, Set<string>>();
  for (const r of routes().filter((r) => r.api)) methods.set(r.pattern, (methods.get(r.pattern) ?? new Set()).add(r.method));
  const asks = [...methods].flatMap(([pattern, taken]) => {
    const path = pathFor(pattern);
    const wrong = ["PATCH", "PUT", "DELETE", "POST", "GET"].find((m) => !taken.has(m) && api.match(m, path) === undefined);
    return wrong === undefined ? [] : [{ path, wrong }];
  });
  wrongMethod.push(
    ...(await lap(async () => [
      ...(await pool(asks, (a) => send(a.wrong, a.path, {}))),
      // A studio path's wrong verb is the same not-found page as any unknown path.
      await send("PATCH", "/", {}),
    ])),
  );
  expect(floorGaps(wrongMethod)).toEqual([]);
  const wrongAnswers = asks
    .map((a, i) => ({ a, s: wrongMethod[i]! }))
    .filter(({ a, s }) =>
      NO_405[a.path] !== undefined ? s.status !== 404 : s.status !== 405 || s.allow !== api.allowed(a.path).join(", "),
    )
    .map(({ s }) => `${s.label} allow=${s.allow}`);
  expect(wrongAnswers).toEqual([]);
  expect(wrongMethod.at(-1)!.status).toBe(404);
}, 2_000);

test("a cross-origin mutation with a session cookie is refused before any handler, and the session lives on", async () => {
  const mutations = routes().filter((r) => MUTATING.has(r.method));
  const seen = await lap(() =>
    pool(mutations, (r) =>
      send(r.method, pathFor(r.pattern), { origin: EVIL, cookie: session, "content-type": "application/x-www-form-urlencoded" }, ""),
    ),
  );
  expect(floorGaps(seen)).toEqual([]);
  expect(seen.filter((s) => s.status !== 403).map((s) => s.label)).toEqual([]);
  expect(seen.filter((s) => s.cookies.length > 0).map((s) => `${s.label} sets ${s.cookies.map(cookieName).join(", ")}`)).toEqual([]);
  const still = sessionOf(app.db, token);
  expect(still.ok && still.value.user.username).toBe(USERNAME);
}, 2_000);

test("signing in from the forge's own page sets the session cookie HttpOnly, with the floor", async () => {
  const form = await send(
    "POST", "/signin",
    { origin: servers.url, "content-type": "application/x-www-form-urlencoded" },
    new URLSearchParams({ username: USERNAME, password: PASSWORD }).toString(),
  );
  const api = await send(
    "POST", "/api/v1/sessions",
    { origin: servers.url, "content-type": "application/json" },
    JSON.stringify({ username: USERNAME, password: PASSWORD }),
  );
  for (const s of [form, api]) {
    expect(s.cookies.some((c) => /^forge_session=[^;]/.test(c))).toBe(true);
    expect(notHttpOnly([s])).toEqual([]);
    expect(s.missing).toEqual([]);
  }
}, 1_000);

test("the three passes' request loops together take under 5 s, so the sweep stays cheap enough for every push", () => {
  expect(loopMs).toBeGreaterThan(0);
  expect(loopMs).toBeLessThan(SWEEP_CEILING_MS);
});

test("every named exception is still an exception, each with its reason", () => {
  const all = [...anonymous, ...wrongMethod];
  for (const [path, why] of Object.entries(FLOOR_EXCEPTIONS)) {
    expect(why.length).toBeGreaterThan(10);
    expect(all.some((s) => s.label.split(" ")[1] === path && s.missing.length > 0)).toBe(true);
  }
  for (const why of [...Object.values(READABLE_COOKIES), ...Object.values(NO_405)]) expect(why.length).toBeGreaterThan(10);
});
