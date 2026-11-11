/**
 * The security floor (`securityFloor` in src/http/respond.ts) on every kind of
 * response, not just every GET route (#10918): a page, a JSON answer, each
 * shape of refusal and error, the 404s, the 304s, the assets, HEAD and
 * OPTIONS, a redirect, the probes and a 500. `security-floor-routes.test.ts`
 * walks the GET route table; this one walks the kinds of answer, which is
 * where a responder that skips the floor would hide — a 304 with no body, a
 * refusal written before any route, a page that writes its own policy.
 *
 * Each sample names its kind and the status it must answer with, so a sample
 * that drifted to another kind of answer fails loudly instead of proving
 * nothing. The three headers asserted are the issue's; HTML writes its own
 * nonce'd policy and the floor fills the rest.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { createRepo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { spriteAsset, stylesheetAsset } from "../src/web/asset.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const FLOOR = ["content-security-policy", "x-content-type-options", "referrer-policy"] as const;

type Sample = {
  kind: string;
  path: string | (() => string);
  status: number;
  init?: RequestInit;
  signedIn?: boolean;
  /** Headers the sample needs that only exist once the first answer is in (a 304's tag). */
  conditional?: boolean;
};

let dataDir = "";
let app: App, servers: Servers;
let cookie = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-floor-kinds-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const admin = await seedAdmin(app, { username: "ada", email: "ada@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  const made = await createRepo(app.db, app.reposRoot, { ownerId: admin.value.id, name: "notes", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  const seed = await commitToBranch(app, admin.value, made.value, { message: "seed", files: [{ path: "a.txt", content: "a\n" }] });
  if (!seed.ok) throw new Error(String(seed.error));
  cookie = `forge_session=${createSession(app.db, admin.value.id).token}`;
}, 30_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

const FOREIGN = { origin: "https://evil.example", "content-type": "application/json" };

const SAMPLES: Sample[] = [
  { kind: "page", path: "/", status: 200 },
  { kind: "page, signed in", path: "/", status: 200, signedIn: true },
  { kind: "repository page", path: "/ada/notes", status: 200 },
  { kind: "HEAD of a page", path: "/", status: 200, init: { method: "HEAD" } },
  { kind: "JSON answer", path: "/api/v1/repos/ada/notes", status: 200 },
  { kind: "JSON answer, signed in", path: "/api/v1/user", status: 200, signedIn: true },
  { kind: "plain text", path: "/robots.txt", status: 200 },
  { kind: "stylesheet asset", path: () => `/assets/${stylesheetAsset().name}.css`, status: 200 },
  { kind: "sprite asset", path: () => `/assets/${spriteAsset().name}.svg`, status: 200 },
  { kind: "304 of an asset", path: () => `/assets/${stylesheetAsset().name}.css`, status: 304, conditional: true },
  { kind: "304 of a JSON answer", path: "/api/v1/repos/ada/notes/issues", status: 304, conditional: true },
  { kind: "404 page", path: "/no/such/path/at/all", status: 404 },
  { kind: "404 of a repository", path: "/ada/nothing-here", status: 404 },
  { kind: "404 JSON, no route", path: "/api/v1/no-such-route", status: 404 },
  { kind: "404 JSON, no resource", path: "/api/v1/repos/ada/nothing-here", status: 404 },
  { kind: "404 of an asset", path: "/assets/not-a-real-hash.css", status: 404 },
  { kind: "404 of a stale asset hash", path: "/assets/stale.js", status: 404 },
  { kind: "405 JSON", path: "/api/v1/repos/ada/notes", status: 405, init: { method: "PUT" } },
  { kind: "401 JSON", path: "/api/v1/user", status: 401 },
  {
    kind: "422 JSON, a body that is not JSON",
    path: "/api/v1/repos/ada/notes/issues",
    status: 422,
    signedIn: true,
    init: { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" },
  },
  {
    kind: "403 JSON, the origin gate",
    path: "/api/v1/repos/ada/notes/issues",
    status: 403,
    signedIn: true,
    init: { method: "POST", headers: FOREIGN, body: "{}" },
  },
  {
    kind: "403 page, the origin gate to a form",
    path: "/new",
    status: 403,
    signedIn: true,
    init: {
      method: "POST",
      headers: { origin: "https://evil.example", accept: "text/html", "content-type": "application/x-www-form-urlencoded" },
      body: "name=x",
    },
  },
  { kind: "redirect", path: "/openapi.json", status: 308 },
  { kind: "OPTIONS, answered as no route", path: "/api/v1", status: 404, init: { method: "OPTIONS" } },
  { kind: "liveness probe", path: "/healthz", status: 200 },
  { kind: "readiness probe", path: "/readyz", status: 200 },
];

async function ask(sample: Sample, extra: Record<string, string> = {}): Promise<Response> {
  const path = typeof sample.path === "function" ? sample.path() : sample.path;
  const headers = new Headers(sample.init?.headers);
  headers.set("accept-encoding", "identity");
  if (sample.signedIn === true) headers.set("cookie", cookie);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return fetch(`${servers.url}${path}`, {
    ...sample.init,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
}

/** What is wrong with one sample's answer: a missing floor header, or the wrong kind of answer. */
async function wrongWith(sample: Sample): Promise<string[]> {
  let res = await ask(sample);
  if (sample.conditional === true) {
    const etag = res.headers.get("etag");
    await res.body?.cancel();
    if (etag === null) return [`${sample.kind}: no etag to revalidate with`];
    res = await ask(sample, { "if-none-match": etag });
  }
  await res.body?.cancel();
  const wrong = FLOOR.filter((h) => !res.headers.get(h)).map((h) => `${sample.kind} (${res.status}) lacks ${h}`);
  if (res.status !== sample.status) wrong.push(`${sample.kind} answered ${res.status}, not ${sample.status}`);
  return wrong;
}

test("every kind of response carries the floor", async () => {
  const wrong = (await Promise.all(SAMPLES.map(wrongWith))).flat();
  expect(wrong).toEqual([]);
}, 15_000);

test("a handler's throw, answered as a 500, carries the floor", async () => {
  // The session read is the first statement a signed-in request makes; a
  // database that throws there is the fault the 500 path exists for.
  const query = app.db.query.bind(app.db);
  app.db.query = (() => {
    throw new Error("the disk went away");
  }) as typeof app.db.query;
  let res: Response;
  try {
    res = await ask({ kind: "500", path: "/api/v1/user", status: 500, signedIn: true });
  } finally {
    app.db.query = query;
  }
  await res.body?.cancel();
  expect(res.status).toBe(500);
  for (const h of FLOOR) expect(res.headers.get(h)).toBeTruthy();
});

test("the floor's own policy is the inert one on anything that is not a page", async () => {
  const res = await ask({ kind: "JSON", path: "/api/v1/repos/ada/notes", status: 200 });
  await res.body?.cancel();
  expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
});
