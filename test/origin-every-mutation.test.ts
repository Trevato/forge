/**
 * Same-origin on every mutation, tested as a whole (#5848, #10918). Every POST,
 * PUT, PATCH and DELETE either router registers is sent signed in with a
 * session cookie and `Origin: https://evil.example`; each must answer 403,
 * leave the event log as it was, and have been refused by an origin check
 * (`crossOrigin` in src/http/context.ts, which the gate in
 * src/http/origin_gate.ts and the handlers' second locks share) — a 403 for
 * any other reason would hide a route with no check at all.
 *
 * A route with no origin check is named in EXEMPT, one line each with its
 * reason, and proven to refuse a cookie-only request. Routes the test cannot
 * reach are named in UNCALLABLE with why. Both lists are checked against the
 * routers, so neither can name a route that is gone or grow without a reason.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createSession } from "../src/core/sessions.ts";
import { buildApiRouter, buildRouter, forgeHttp } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

/**
 * Mutations with no origin check, each with why. Every one reads only
 * `Authorization: Bearer`, never a cookie, so a browser cannot be made to call
 * it as someone: a cookie alone must get a 401 (or 405), which a test proves.
 * Add a line here only with a reason a reviewer can check.
 */
const EXEMPT: Record<string, string> = {
  "POST /mcp": "the MCP endpoint reads a bearer token only; a cookie is never an identity there",
  "DELETE /mcp": "ends an MCP session named by a bearer's session header; a cookie is never an identity there",
  "POST /oauth/userinfo": "OAuth userinfo answers the bearer access token it is sent, never a cookie",
};

/** Routes the test cannot call, with why. Each must be a registered mutation. */
const UNCALLABLE: Record<string, string> = {};

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const FILL: Record<string, string> = {
  owner: "alice", username: "alice", name: "notes", number: "1", org: "alice", slug: "main",
  id: "1", team: "core", scope: "alice", job: "1", oid: "0", env: "prod",
};
const fill = (pattern: string): string =>
  pattern.replace(/:([a-z_]+)/g, (_, k: string) => FILL[k] ?? "x").replace(/\*[a-z_]+/, "x");

const key = (r: { method: string; pattern: string }): string => `${r.method} ${r.pattern}`;
const mutations = (): { method: string; pattern: string }[] =>
  [...buildRouter().routes(), ...buildApiRouter().routes()].filter((r) => MUTATING.has(r.method));

let dataDir = "", app: App, cookie = "";
/** How many times an origin check has refused a request, read from the log line `crossOrigin` writes. */
let originRefusals = 0;
const cells = process.env["FORGE_CELLS"];

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-xo-"));
  app = createApp({ dataDir, port: 0 });
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  const repo = await createRepo(app, admin.value, { name: "notes", visibility: "public", description: "" });
  if (!repo.ok) throw new Error(String(repo.error));
  for (const [branch, file] of [[undefined, "forge.json"], ["topic", "t.txt"]] as const) {
    const done = await commitToBranch(app, admin.value, repo.value, {
      ...(branch === undefined ? {} : { branch }),
      message: "change",
      files: [{ path: file, content: file === "forge.json" ? "{}" : "x" }],
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
  }
  const pull = await openPull(app, admin.value, repo.value, { title: "t", body: "", baseBranch: "main", headBranch: "topic" });
  if (!pull.ok) throw new Error(JSON.stringify(pull.error));
  cookie = `forge_session=${createSession(app.db, admin.value.id).token}`;
  const warn = app.log.warn.bind(app.log);
  app.log.warn = (message, fields) => {
    if (message === "refused cross-origin mutation") originRefusals++;
    warn(message, fields);
  };
});

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
});

const events = (): number => (app.db.query("select count(*) as n from event").get() as { n: number }).n;

async function send(r: { method: string; pattern: string }, origin: string | undefined): Promise<number> {
  const headers: Record<string, string> = { cookie, "content-type": "application/json" };
  if (origin !== undefined) headers["origin"] = origin;
  const res = await forgeHttp(app).handle(
    new Request(`http://forge.test${fill(r.pattern)}`, { method: r.method, headers, body: "{}" }),
  );
  await res.body?.cancel();
  return res.status;
}

test("every mutating route refuses a signed-in request from a foreign Origin, writing nothing", async () => {
  const routes = mutations();
  expect(routes.length).toBeGreaterThan(100);
  const wrong: string[] = [];
  for (const r of routes) {
    if (key(r) in EXEMPT || key(r) in UNCALLABLE) continue;
    const before = events();
    const refusedBefore = originRefusals;
    const status = await send(r, "https://evil.example");
    const checked = originRefusals > refusedBefore;
    if (status !== 403 || events() !== before || !checked)
      wrong.push(`${key(r)} → ${status}, ${events() - before} events${checked ? "" : ", no origin check"}`);
  }
  expect(wrong).toEqual([]);
});

test("every exempt route is a registered mutation with a reason, and a cookie alone is refused there", async () => {
  const registered = new Set(mutations().map(key));
  for (const [route, why] of Object.entries(EXEMPT)) {
    expect(registered.has(route)).toBe(true);
    expect(why.length).toBeGreaterThan(20);
    const [method, pattern] = route.split(" ") as [string, string];
    const before = events();
    // 401 for no credential; 405 where the route answers nothing but a bearer's POST.
    expect([401, 405]).toContain(await send({ method, pattern }, undefined));
    expect(events()).toBe(before);
  }
});

test("the uncallable list names only registered routes, each with a reason", () => {
  const registered = new Set(mutations().map(key));
  for (const [route, why] of Object.entries(UNCALLABLE)) {
    expect(registered.has(route)).toBe(true);
    expect(why.length).toBeGreaterThan(20);
  }
});

test("a same-origin request is not caught by the gate", async () => {
  const res = await forgeHttp(app).handle(
    new Request("http://forge.test/api/v1/user/email/verify", {
      method: "POST",
      headers: { cookie, origin: "http://forge.test", "content-type": "application/json" },
      body: "{}",
    }),
  );
  expect(res.status).not.toBe(403);
});

const REPLY = "http://forge.test/api/v1/user/email/verify";
const foreign = (authorization: string): Promise<Response> =>
  forgeHttp(app).handle(
    new Request(REPLY, {
      method: "POST",
      headers: { authorization, origin: "https://evil.example", "content-type": "application/json" },
      body: "{}",
    }),
  );

test("the account password, which a browser caches after the Basic challenge, is gated too", async () => {
  const before = events();
  const res = await foreign(`Basic ${btoa("alice:correct-horse-battery")}`);
  expect(res.status).toBe(403);
  expect(events()).toBe(before);
});

test("token callers are exempt: a foreign Origin is not refused by the gate", async () => {
  const user = app.db.query("select id from user where username = 'alice'").get() as { id: string };
  const { token } = createToken(app.db, user.id, "xo", "admin");
  expect((await foreign(`Bearer ${token}`)).status).not.toBe(403);
  expect((await foreign(`Basic ${btoa(`alice:${token}`)}`)).status).not.toBe(403);
});
