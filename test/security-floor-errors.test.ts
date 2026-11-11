/**
 * The security floor on the error paths nobody looks at (#10949): each of
 * 400, 401, 403, 404, 405, 413 and 500, provoked once on a page route and
 * once on an API route, must leave with Content-Security-Policy,
 * X-Content-Type-Options and Referrer-Policy. A 500 must also say nothing of
 * the fault: no stack, no path, no secret.
 *
 * `security-floor-every-route.test.ts` walks the kinds of answer; this one
 * walks the error statuses, page and API side by side, so a status that only
 * one side covers cannot hide a responder that skips the floor on the other.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { BODY_MAX } from "../src/http/limits.ts";
import { apiError, forbidden, json, methodNotAllowed, notFound, respondAccess, tryAgain, unauthorized } from "../src/http/respond.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const FLOOR = ["content-security-policy", "x-content-type-options", "referrer-policy"] as const;
const SECRET = "hunter2-the-database-password";

type Side = "page" | "api";
type Provoke = { status: number; side: Side; path: string; init?: RequestInit; signedIn?: boolean; failing?: boolean };

let dataDir = "";
let app: App, servers: Servers;
let cookie = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-floor-errors-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const admin = await seedAdmin(app, { username: "ada", email: "ada@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  const made = await createRepo(app.db, app.reposRoot, { ownerId: admin.value.id, name: "notes", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  cookie = `forge_session=${createSession(app.db, admin.value.id).token}`;
}, 30_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

const HTML = { accept: "text/html" };
const own = () => ({ origin: servers.url, ...HTML });
const tooBig = () => new Uint8Array(BODY_MAX + 1024);

const PROVOKED = (): Provoke[] => [
  // 400
  { status: 400, side: "page", path: "/talk/stream?after=not-a-turn", signedIn: true, init: { headers: HTML } },
  { status: 400, side: "api", path: "/api/v1/explore?cursor=not-a-cursor" },
  // 401
  { status: 401, side: "page", path: "/talk/stream?after=x", init: { headers: HTML } },
  { status: 401, side: "api", path: "/api/v1/user" },
  // 403: the origin gate, for a form and for JSON
  {
    status: 403,
    side: "page",
    path: "/new",
    signedIn: true,
    init: { method: "POST", headers: { origin: "https://evil.example", ...HTML, "content-type": "application/x-www-form-urlencoded" }, body: "name=x" },
  },
  {
    status: 403,
    side: "api",
    path: "/api/v1/repos/ada/notes/issues",
    signedIn: true,
    init: { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" },
  },
  // 404
  { status: 404, side: "page", path: "/no/such/path/at/all", init: { headers: HTML } },
  { status: 404, side: "api", path: "/api/v1/repos/ada/nothing-here" },
  // 405
  // A page path under the wrong method answers 404 (the page router keeps no
  // method table); the page that answers 405 is /mcp, to a browser.
  { status: 405, side: "page", path: "/mcp", init: { headers: HTML } },
  { status: 404, side: "page", path: "/ada/notes", init: { method: "PUT", headers: HTML } },
  { status: 405, side: "api", path: "/api/v1/repos/ada/notes", init: { method: "PUT" } },
  // 413: a body past the cap, a form and JSON
  {
    status: 413,
    side: "page",
    path: "/new",
    signedIn: true,
    init: { method: "POST", headers: { ...own(), "content-type": "application/x-www-form-urlencoded" }, body: tooBig() },
  },
  {
    status: 413,
    side: "api",
    path: "/api/v1/repos/ada/notes/issues",
    signedIn: true,
    init: { method: "POST", headers: { origin: servers.url, "content-type": "application/json" }, body: tooBig() },
  },
  // The same with an Idempotency-Key, which reads the body on its own path.
  {
    status: 413,
    side: "api",
    path: "/api/v1/repos/ada/notes/issues",
    signedIn: true,
    init: { method: "POST", headers: { origin: servers.url, "content-type": "application/json", "idempotency-key": "k1" }, body: tooBig() },
  },
  // 500: the database throws under a handler
  { status: 500, side: "page", path: "/", signedIn: true, failing: true, init: { headers: HTML } },
  { status: 500, side: "api", path: "/api/v1/user", signedIn: true, failing: true },
];

async function provoke(p: Provoke): Promise<{ res: Response; body: string }> {
  const headers = new Headers(p.init?.headers);
  headers.set("accept-encoding", "identity");
  if (p.signedIn === true) headers.set("cookie", cookie);
  const query = app.db.query.bind(app.db);
  if (p.failing === true)
    app.db.query = (() => {
      throw new Error(`SQLITE_IOERR at ${dataDir}/forge.db with password=${SECRET}`);
    }) as typeof app.db.query;
  try {
    // A fresh connection each: an oversize body closes its connection, and a
    // client that reused it would read the runtime's own bare 400 instead.
    const res = await fetch(`${servers.url}${p.path}`, {
      ...p.init,
      headers,
      keepalive: false,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    return { res, body: await res.text() };
  } finally {
    app.db.query = query;
  }
}

test("each error status, on a page and on the API, carries the floor", async () => {
  const wrong: string[] = [];
  // One at a time: a 500 swaps the database's query for a throwing one.
  for (const p of PROVOKED()) {
    const { res } = await provoke(p);
    const name = `${p.status} ${p.side} ${p.init?.method ?? "GET"} ${p.path}`;
    if (res.status !== p.status) wrong.push(`${name} answered ${res.status}`);
    for (const h of FLOOR) if (!res.headers.get(h)) wrong.push(`${name} lacks ${h}`);
  }
  expect(wrong).toEqual([]);
}, 30_000);

test("every status in the issue is walked on both sides", () => {
  const walked = new Set(PROVOKED().map((p) => `${p.status}:${p.side}`));
  for (const status of [400, 401, 403, 404, 405, 413, 500])
    for (const side of ["page", "api"]) expect(walked.has(`${status}:${side}`)).toBe(true);
});

test("a 500 names no stack, path or secret", async () => {
  for (const p of PROVOKED().filter((p) => p.status === 500)) {
    const { res, body } = await provoke(p);
    expect(res.status).toBe(500);
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain(dataDir);
    expect(body).not.toContain("SQLITE_IOERR");
    expect(body).not.toMatch(/\bat .+:\d+:\d+/); // a stack frame
    expect(body).not.toContain("/src/");
  }
});

test("every responder in respond.ts lays the floor itself, before the server's door", () => {
  const built = [
    json({ ok: true }),
    apiError("bad_query", 400, "no"),
    unauthorized(),
    forbidden(),
    notFound(),
    methodNotAllowed("PUT", ["GET", "HEAD"]),
    apiError("too_large", 413, "no"),
    json({ error: "internal" }, 500),
    respondAccess("refused", 403),
    tryAgain("slow_down", 429, "wait", 5),
  ];
  for (const res of built) {
    for (const h of FLOOR) expect(res.headers.get(h)).toBeTruthy();
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  }
});

test("a responder's own policy survives the floor", () => {
  const res = json({}, 200, { "content-security-policy": "sandbox" });
  expect(res.headers.get("content-security-policy")).toBe("sandbox");
});

test("an oversize JSON body is refused 413 before the route acts on it", async () => {
  const { res, body } = await provoke({
    status: 413,
    side: "api",
    path: "/api/v1/repos/ada/notes/issues",
    signedIn: true,
    init: { method: "POST", headers: { origin: servers.url, "content-type": "application/json" }, body: tooBig() },
  });
  expect(res.status).toBe(413);
  expect(JSON.parse(body).error).toBe("too_large");
  const listed = await fetch(`${servers.url}/api/v1/repos/ada/notes/issues`, { headers: { cookie } });
  expect(((await listed.json()) as { items: unknown[] }).items).toEqual([]);
});
