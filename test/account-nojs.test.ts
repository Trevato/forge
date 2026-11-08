/**
 * Settings › Account is fast and works with no script (#9751). Speed is held
 * as work (SQL statements), never a wall clock (#4429).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";
import { expectWork, requestStatements } from "./helpers/work.ts";

quietLogs();

const EDGE_TOKEN = "edge-secret-for-the-test";
const PARENT = "https://parent.test";
/** Measured: a warm /settings costs STATEMENTS_MEASURED statements; the ceiling sits just above it, so an N+1 fails. */
const TOKEN_STATUS = 303, KEY_STATUS = 303, PARENT_STATUS = 502, EDGE_STATUS = 303;
const STATEMENTS_MEASURED = 19;
const STATEMENT_CEILING = STATEMENTS_MEASURED + 2;
let root = "";
let app: App;
let servers: Servers;
let cookie = "";
let bobCookie = "";

/** The `app` phase of Server-Timing, or NaN. Reported, never judged (#4429). */
function appMs(res: Response): number {
  const part = (res.headers.get("server-timing") ?? "").split(",").map((p) => p.trim()).find((p) => p.startsWith("app;"));
  return Number(/dur=([\d.]+)/.exec(part ?? "")?.[1] ?? "NaN");
}
/** The platform edge vouching for a login, as it does in front of the forge. */
const edge = { "x-plat-edge-token": EDGE_TOKEN, "x-plat-user": "octo" };
const get = (path: string) => fetch(servers.url + path, { headers: { cookie, ...edge } });
const post = (path: string, body: Record<string, string>, origin: string) =>
  fetch(servers.url + path, {
    method: "POST",
    headers: { cookie, origin, ...edge },
    body: new URLSearchParams(body),
    redirect: "manual",
  });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-account-nojs-"));
  app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge", edgeToken: EDGE_TOKEN, parentUrl: PARENT });
  const u = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  proveAll(app);
  servers = await serve(app);
  // An unverified account with a real email is the one shown "resend the link".
  const bob = await createUser(app.db, { origin: "seed", username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
  if (!bob.ok) throw new Error(bob.error);
  bobCookie = `forge_session=${createSession(app.db, bob.value.id).token}`;
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("a warm /settings sends its app phase and costs a bounded number of statements", async () => {
  await (await get("/settings")).text();
  const second = await get("/settings");
  expect(second.status).toBe(200);
  await second.text();
  expect(appMs(second)).not.toBeNaN();
  const n = await requestStatements(app.db, servers.url + "/settings", { headers: { cookie, ...edge } });
  expectWork(n, { max: STATEMENT_CEILING });
});

test("the page content (<main>, the shell excluded) depends on no script or inline handler, and its forms are in the server-rendered HTML", async () => {
  for (const path of ["/settings", "/settings/tokens", "/settings/keys"]) {
    const res = await get(path);
    expect(res.status).toBe(200);
    // The page's own content is <main>; the shell around it may carry progressive enhancement.
    const main = /<main\b[\s\S]*<\/main>/i.exec(await res.text())?.[0] ?? "";
    expect(main).toContain("<form");
    expect(main).not.toMatch(/<script\b/i);
    expect(main).not.toMatch(/\son[a-z]+\s*=/i);
    expect(main).not.toMatch(/href="javascript:/i);
  }
});

/** Every mutating form the three pages carry for this user, by action. */
const EXPECTED = [
  "/settings", // profile
  "/settings/notify",
  "/settings/everyday",
  "/settings/everyday/keep",
  "/settings/email/verify", // shown to an unverified user only: bob
  "/settings/password",
  "/settings/tokens",
  "/settings/keys",
  "/settings/edge/link",
  "/settings/parent/link",
];

test("every form is a plain post form: the expected set is rendered and each refuses a cross-origin post", async () => {
  const found = new Set<string>();
  for (const path of ["/settings", "/settings/tokens", "/settings/keys", "/settings/password", "bob"]) {
    const html = await (path === "bob"
      ? fetch(servers.url + "/settings", { headers: { cookie: bobCookie } })
      : get(path)
    ).then((r) => r.text());
    for (const m of html.matchAll(/<form\b[^>]*>/gi)) {
      const f = m[0];
      const action = /action="(\/settings[^"]*)"/.exec(f)?.[1];
      if (action === undefined) continue;
      expect(f).toMatch(/method="post"/i);
      found.add(action);
    }
  }
  expect([...found].sort()).toEqual([...EXPECTED].sort());
  for (const action of found) {
    const res = await post(action, {}, "https://evil.example");
    expect(res.status).toBe(403);
  }
});

test("a same-origin post lands: token and key rows appear, the status is pinned", async () => {
  const refused = await post("/settings/tokens", { name: "ci-box", scope: "ro", aiAdmin: "on" }, "https://evil.example");
  expect(refused.status).toBe(403);
  expect(await (await get("/settings/tokens")).text()).not.toContain("ci-box");
  const landed = await post("/settings/tokens", { name: "ci-box", scope: "ro", aiAdmin: "on" }, servers.url);
  expect(landed.status).toBe(TOKEN_STATUS);
  expect(await (await get("/settings/tokens")).text()).toContain("ci-box");

  const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl laptop";
  expect((await post("/settings/keys", { name: "laptop", key }, "https://evil.example")).status).toBe(403);
  expect(await (await get("/settings/keys")).text()).not.toContain("laptop");
  const added = await post("/settings/keys", { name: "laptop", key }, servers.url);
  expect(added.status).toBe(KEY_STATUS);
  expect(await (await get("/settings/keys")).text()).toContain("laptop");
});

test("the sign-in link forms: cross-origin refused, same-origin gets past the origin gate", async () => {
  // The parent round trip cannot reach parent.test from here: past the gate it answers 502, not 403.
  const parent = await post("/settings/parent/link", {}, servers.url);
  expect(parent.status).toBe(PARENT_STATUS);
  const linked = await post("/settings/edge/link", {}, servers.url);
  expect(linked.status).toBe(EDGE_STATUS);
  expect(linked.headers.get("location")).toBe("/settings");
  expect(await (await get("/settings")).text()).toContain("linked as <strong>octo</strong>");
});
