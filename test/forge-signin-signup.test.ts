/**
 * The parent's sign-in makes no account, so it never touches the sign-up
 * window the passkey door spends: a linked person signs in, an unknown one
 * is sent to /signup.
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

/**
 * The redirect one hop answered with, or a throw that names the hop, its
 * status and the start of its body: a red here says which step went wrong
 * (#9978), never a bare "null is not a URL".
 */
async function hop(where: string, res: Response, to: string): Promise<URL> {
  const location = res.headers.get("location");
  if (res.status === 303 && location !== null && new URL(location, to).href.startsWith(to)) return new URL(location, to);
  const text = await res.text();
  const main = text.includes("<main") ? text.slice(text.indexOf("<main")) : text;
  const body = main.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
  throw new Error(`${where}: ${res.status}, location ${location ?? "none"}, not a 303 to ${to}; body: ${body}`);
}

/** One full sign-in at the child as the parent's person with `cookie`; the callback's response. */
async function through(cookie: string): Promise<Response> {
  const start = await fetch(`${cs.url}/signin/parent`, { redirect: "manual" });
  const to = await hop("the child's /signin/parent", start, `${ps.url}/oauth/authorize?`);
  const consent = await fetch(`${ps.url}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, origin: ps.url },
    body: new URLSearchParams({ ...Object.fromEntries(to.searchParams), decision: "allow" }),
  });
  const back = await hop("the parent's consent", consent, `${cs.url}/signin/parent/callback?`);
  const state = cookieOf(start, "forge_rp");
  if (state === undefined) throw new Error("the child's /signin/parent set no forge_rp cookie");
  return fetch(`${cs.url}${back.pathname}${back.search}`, { redirect: "manual", headers: { cookie: state } });
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
    const made = await createUser(parent.db, { origin: "seed", username: name, email: `${name}@parent.local`, password: "a-long-family-passphrase", adminIfFirst: name === "amy" });
    if (!made.ok) throw new Error(made.error);
    cookies[name] = `forge_session=${createSession(parent.db, made.value.id).token}`;
  }
  const seeded = await createUser(child.db, { origin: "seed", username: "olive", email: "olive@f.dev", password: "a-long-family-passphrase", trusted: true });
  if (!seeded.ok) throw new Error(seeded.error);
  const actor = seeded.value.id;
  // Two sign-ups a minute from this source, shared by every door.
  setLimit(child.db, "signup.per_source", 2, actor);
  // Two forges boot here: on a loaded check host that outlasts bun's 5 s default.
}, 30_000);

afterAll(async () => {
  ps.stop();
  cs.stop();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

test("a linked sub signs in and is not throttled; an unknown sub makes no account and spends no sign-up window; the passkey door keeps the window", async () => {
  const amy = await createUser(child.db, { origin: "seed", username: "amy", email: "amy@child.local", password: "a-long-family-passphrase", trusted: true });
  if (!amy.ok) throw new Error(amy.error);
  const amyParent = getUserByName(parent.db, "amy")!;
  child.db
    .query("INSERT INTO federated_identity (issuer, sub, user_id) VALUES (?1, ?2, ?3)")
    .run(new URL(ps.url).origin, amyParent.id, amy.value.id);
  for (let i = 0; i < 3; i++) {
    const done = await through(cookies.amy!);
    expect(done.status).toBe(303);
    expect(cookieOf(done, "forge_session")).toBeDefined();
  }

  const unknown = await through(cookies.ben!);
  expect(unknown.status).toBe(303);
  expect(unknown.headers.get("location")).toStartWith("/signup");
  expect(getUserByName(child.db, "ben")).toBeUndefined();

  // The window is untouched by all of that: two passkey sign-ups, then the wait.
  expect((await passkeySignUp("pk1")).status).toBe(201);
  expect((await passkeySignUp("pk2")).status).toBe(201);
  expect((await passkeySignUp("pk3")).status).toBe(429);
});
