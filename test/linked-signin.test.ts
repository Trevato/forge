/**
 * Linked sign-in methods (#2883) are for an account you already have: the
 * pages say so and never offer to "Continue with" one, and a first sign-in
 * through one for an identity no account holds makes no user and ends on
 * /signup with a sentence on how to get an account.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dirs: string[] = [];
let parent: App;
let child: App;
let ps: Servers;
let cs: Servers;
let stranger = "";

beforeAll(async () => {
  const make = async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-linked-"));
    dirs.push(dir);
    return dir;
  };
  parent = createApp({ dataDir: await make(), port: 0 });
  ps = await serve(parent);
  child = createApp({ dataDir: await make(), port: 0, parentUrl: ps.url, parentLoopback: true, edgeToken: "edge-secret", edgeName: "the platform" });
  cs = await serve(child);
  const made = await createUser(parent.db, { origin: "seed", username: "newcomer", email: "n@parent.local", password: "a-long-family-passphrase", adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  stranger = `forge_session=${createSession(parent.db, made.value.id).token}`;
});

afterAll(async () => {
  ps.stop();
  cs.stop();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

test("no sign-in or sign-up page says Continue with; linked methods sit under their heading", async () => {
  for (const path of ["/signin", "/signup", "/signin?next=%2Fnew"]) {
    const text = await (await fetch(`${cs.url}${path}`, { redirect: "follow" })).text();
    expect(text).not.toContain("Continue with");
  }
  const text = await (await fetch(`${cs.url}/signin`)).text();
  expect(text).toContain("<h2>Link an account you have</h2>");
  expect(text).toContain("never make one");
  expect(text).toContain('href="/signin/parent"');
  expect(text).toContain(`Sign in through ${new URL(ps.url).host}`);
  expect(text).toContain("/_plat/login");
});

test("an unknown linked identity creates no user and ends on /signup saying how to get an account", async () => {
  const users = () => child.db.query("SELECT COUNT(*) AS n FROM user").get();
  const before = users();
  const start = await fetch(`${cs.url}/signin/parent`, { redirect: "manual" });
  const to = new URL(start.headers.get("location")!);
  const consent = await fetch(`${ps.url}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: stranger, origin: ps.url },
    body: new URLSearchParams({ ...Object.fromEntries(to.searchParams), decision: "allow" }),
  });
  const back = new URL(consent.headers.get("location")!);
  const rp = start.headers.getSetCookie().map((c) => c.split(";")[0]!).find((c) => c.startsWith("forge_rp="))!;
  const done = await fetch(`${cs.url}${back.pathname}${back.search}`, { redirect: "manual", headers: { cookie: rp } });
  expect(done.status).toBe(303);
  expect(done.headers.getSetCookie().some((c) => c.startsWith("forge_session=") && !c.startsWith("forge_session=;"))).toBe(false);
  expect(users()).toEqual(before);
  const landing = done.headers.get("location")!;
  expect(landing.startsWith("/signup")).toBe(true);
  const text = await (await fetch(`${cs.url}${landing}`, { headers: { "x-plat-edge-token": "edge-secret", "x-plat-user": "newcomer" } })).text();
  expect(text).toContain("make one with the form below");
  expect(users()).toEqual(before);
});

test("a parent identity with an existing link still signs in", async () => {
  const mine = await createUser(child.db, { origin: "seed", username: "linked-me", email: "me@child.local" });
  if (!mine.ok) throw new Error(mine.error);
  const sub = (parent.db.query("SELECT id FROM user WHERE username = 'newcomer'").get() as { id: string }).id;
  child.db.query("INSERT INTO federated_identity (issuer, sub, user_id) VALUES (?1, ?2, ?3)").run(new URL(ps.url).origin, sub, mine.value.id);
  const start = await fetch(`${cs.url}/signin/parent`, { redirect: "manual" });
  const to = new URL(start.headers.get("location")!);
  const consent = await fetch(`${ps.url}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: stranger, origin: ps.url },
    body: new URLSearchParams({ ...Object.fromEntries(to.searchParams), decision: "allow" }),
  });
  const back = new URL(consent.headers.get("location")!);
  const rp = start.headers.getSetCookie().map((c) => c.split(";")[0]!).find((c) => c.startsWith("forge_rp="))!;
  const done = await fetch(`${cs.url}${back.pathname}${back.search}`, { redirect: "manual", headers: { cookie: rp } });
  expect(done.headers.get("location")).toBe("/");
  expect(done.headers.getSetCookie().some((c) => c.startsWith("forge_session=") && !c.startsWith("forge_session=;"))).toBe(true);
});
