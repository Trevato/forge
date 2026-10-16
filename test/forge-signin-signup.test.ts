/**
 * First sight of a person through the parent is a sign-up: it shares the
 * sign-up window with the passkey door, is refused with the wait when the
 * window is spent, and makes no account. A returning person is a sign-in and
 * is never held to that window.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { setLimit } from "../src/settings/limits.ts";
import { device } from "./helpers/passkey.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dirs: string[] = [];
let parent: App;
let child: App;
let ps: Servers;
let cs: Servers;
const cookies: Record<string, string> = {};

const cookieOf = (res: Response, name: string) =>
  res.headers.getSetCookie().map((c) => c.split(";")[0]!).find((c) => c.startsWith(`${name}=`));

/** One full sign-in at the child as the parent's person with `cookie`; the callback's response. */
async function through(cookie: string): Promise<Response> {
  const start = await fetch(`${cs.url}/signin/parent`, { redirect: "manual" });
  const to = new URL(start.headers.get("location")!);
  const consent = await fetch(`${ps.url}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, origin: ps.url },
    body: new URLSearchParams({ ...Object.fromEntries(to.searchParams), decision: "allow" }),
  });
  const back = new URL(consent.headers.get("location")!);
  return fetch(`${cs.url}${back.pathname}${back.search}`, { redirect: "manual", headers: { cookie: cookieOf(start, "forge_rp")! } });
}

const post = (path: string, body: unknown) =>
  fetch(`${cs.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function passkeySignUp(name: string) {
  const d = await device(new URL(cs.url).origin, new URL(cs.url).hostname);
  const email = `${name}@f.dev`;
  const o = (await (await post("/signup/passkey/options", { username: name, email })).json()) as any;
  return post("/signup/passkey", { username: name, email, challenge: o.challenge, ...(await d.create(o.challenge)) });
}

beforeAll(async () => {
  const make = async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-signin-signup-"));
    dirs.push(dir);
    return dir;
  };
  parent = createApp({ dataDir: await make(), port: 0 });
  ps = await serve(parent);
  child = createApp({ dataDir: await make(), port: 0, parentUrl: ps.url, parentLoopback: true });
  cs = await serve(child);
  for (const name of ["amy", "ben"]) {
    const made = await createUser(parent.db, { username: name, email: `${name}@parent.local`, password: "a-long-family-passphrase", adminIfFirst: name === "amy" });
    if (!made.ok) throw new Error(made.error);
    cookies[name] = `forge_session=${createSession(parent.db, made.value.id).token}`;
  }
  const seeded = await createUser(child.db, { username: "olive", email: "olive@f.dev", password: "a-long-family-passphrase", trusted: true });
  if (!seeded.ok) throw new Error(seeded.error);
  const actor = seeded.value.id;
  // Two sign-ups a minute from this source, shared by every door.
  setLimit(child.db, "signup.per_source", 2, actor);
});

afterAll(async () => {
  ps.stop();
  cs.stop();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

test("a new sub past the sign-up limit is refused with the wait and makes no account; a returning sub is not throttled; the passkey door shares the window", async () => {
  expect((await through(cookies.amy!)).status).toBe(303);
  expect(getUserByName(child.db, "amy")).toBeDefined();
  expect((await passkeySignUp("pk1")).status).toBe(201);

  const refused = await through(cookies.ben!);
  expect(refused.status).toBe(429);
  expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(await refused.text()).toContain("Try again in");
  expect(getUserByName(child.db, "ben")).toBeUndefined();

  // Amy is known here: signing in again is not a sign-up.
  const again = await through(cookies.amy!);
  expect(again.status).toBe(303);
  expect(cookieOf(again, "forge_session")).toBeDefined();
  expect(child.db.query("SELECT COUNT(*) AS n FROM user WHERE username = 'amy'").get()).toEqual({ n: 1 });

  // And the spent window holds the passkey door too.
  expect((await passkeySignUp("pk2")).status).toBe(429);
});
