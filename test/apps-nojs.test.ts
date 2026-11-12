/**
 * The /apps list is fast and works with no script (#9752). Speed is held as
 * work (SQL statements that do not grow with the number of apps), never a
 * wall clock (#4429).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp as makeAppRecord } from "../src/core/apps.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { expectWork, requestStatements } from "./helpers/work.ts";

let dir = "";
let app: App;
let servers: Servers;
let cookie = "";
let made = 0;

/** The `app` phase of Server-Timing (the handler's own time), or NaN. Reported, never judged (#4429). */
function appMs(res: Response): number {
  const part = (res.headers.get("server-timing") ?? "").split(",").map((p) => p.trim()).find((p) => p.startsWith("app;"));
  return Number(/dur=([\d.]+)/.exec(part ?? "")?.[1] ?? "NaN");
}
const get = () => fetch(`${servers.url}/apps`, { headers: { cookie } });

async function addApps(n: number): Promise<void> {
  const alice = getUserByName(app.db, "alice")!;
  for (let i = 0; i < n; i++, made++) {
    const r = await createRepo(app, alice, { name: `nojs-${made}`, visibility: "public", description: "an app" });
    if (!r.ok) throw new Error(String(r.error));
    const rec = makeAppRecord(app.db, { repoId: r.value.id, slug: `nojs${made}`, access: "public" });
    if (!rec.ok) throw new Error(String(rec.error));
  }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-apps-nojs-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!u.ok) throw new Error(u.error);
  const res = await fetch(`${servers.url}/signin`, { method: "POST", headers: { origin: servers.url }, body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }), redirect: "manual" });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  await addApps(3);
}, 60_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("a warm /apps sends its app phase and its statement count does not grow with the apps", async () => {
  await (await get()).text();
  const second = await get();
  const body = await second.text();
  expect(second.status).toBe(200);
  expect(body).toContain("nojs-2");
  expect(appMs(second)).not.toBeNaN();
  const few = await requestStatements(app.db, `${servers.url}/apps`, { headers: { cookie } });
  expectWork(few, { max: 60 });
  await addApps(6);
  const many = await requestStatements(app.db, `${servers.url}/apps`, { headers: { cookie } });
  expectWork(many, { max: few });
});

test("the list works with every script stripped: plain links and a plain same-origin post form", async () => {
  const html = await (await get()).text();
  const main = html.slice(html.indexOf("<h1>Apps</h1>"));
  const stripped = main.replace(/<script\b[\s\S]*?<\/script>/gi, "");
  for (let i = 0; i < made; i++) expect(stripped).toMatch(new RegExp(`<a\\b[^>]*href="/[^"]*nojs-${i}"`));
  expect(stripped).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
  expect(stripped).not.toMatch(/href="\s*(javascript:|#)/i);
  // The new-app step is one plain link away, and there a plain form.
  expect(stripped).toMatch(/<a\b[^>]*href="\/apps\/new"/);
  const step = await (await fetch(`${servers.url}/apps/new`, { headers: { cookie } })).text();
  const form = /<form\b[^>]*action="\/apps\/new"[^>]*>/.exec(step)?.[0] ?? "";
  expect(form).toMatch(/method="post"/i);
  // The same-origin check: a cross-origin post is refused, a same-origin one is not.
  const body = new URLSearchParams({ name: "x" });
  const cross = await fetch(`${servers.url}/apps/new`, { method: "POST", headers: { cookie, origin: "https://evil.example" }, body, redirect: "manual" });
  expect(cross.status).toBe(403);
  const same = await fetch(`${servers.url}/apps/new`, { method: "POST", headers: { cookie, origin: servers.url }, body, redirect: "manual" });
  expect(same.status).not.toBe(403);
});
