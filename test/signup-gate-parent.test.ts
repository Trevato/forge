/**
 * The parent forge's sign-in is a way in for strangers like any other: while
 * the child's signup is `closed` or `invite`, a person the child has never
 * seen gets no account and no session there. Open again, they get one.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { setSignup, type SignupMode } from "../src/settings/signup.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASSWORD = "a-long-family-passphrase";
const dirs: string[] = [];
let parent: App;
let child: App;
let ps: Servers;
let cs: Servers;
let owner = "";
const cookies = new Map<string, string>();

const cookieOf = (res: Response, name: string): string =>
  res.headers.getSetCookie().map((c) => c.split(";")[0] ?? "").find((c) => c.startsWith(`${name}=`)) ?? "";

/** One full sign-in at the child as the parent's `name`; the callback's response. */
async function through(name: string): Promise<Response> {
  const start = await fetch(`${cs.url}/signin/parent`, { redirect: "manual" });
  const to = new URL(start.headers.get("location") ?? "");
  const consent = await fetch(`${ps.url}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: cookies.get(name) ?? "", origin: ps.url },
    body: new URLSearchParams({ ...Object.fromEntries(to.searchParams), decision: "allow" }),
  });
  const back = new URL(consent.headers.get("location") ?? "");
  return fetch(`${cs.url}${back.pathname}${back.search}`, {
    redirect: "manual",
    headers: { cookie: cookieOf(start, "forge_rp") },
  });
}

beforeAll(async () => {
  const make = async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-signup-gate-parent-"));
    dirs.push(dir);
    return dir;
  };
  parent = createApp({ dataDir: await make(), port: 0 });
  ps = await serve(parent);
  child = createApp({ dataDir: await make(), port: 0, parentUrl: ps.url, parentLoopback: true });
  cs = await serve(child);
  for (const name of ["alice", "bea", "cleo"]) {
    const made = await createUser(parent.db, { origin: "seed", username: name, email: `${name}@parent.local`, password: PASSWORD, adminIfFirst: true });
    if (!made.ok) throw new Error(made.error);
    cookies.set(name, `forge_session=${createSession(parent.db, made.value.id).token}`);
  }
  const olga = await createUser(child.db, { origin: "seed", username: "olga", email: "olga@child.local", password: PASSWORD, adminIfFirst: true, trusted: true });
  if (!olga.ok) throw new Error(olga.error);
  owner = olga.value.id;
});

afterAll(async () => {
  ps.stop();
  cs.stop();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const modes: [SignupMode, string][] = [["closed", "alice"], ["invite", "bea"], ["open", "cleo"]];
for (const [mode, name] of modes) {
  test(`signup ${mode}: a parent's person new to the child gets no account and no session`, async () => {
    setSignup(child.db, mode, owner);
    const before = child.db.query("SELECT COUNT(*) AS n FROM user").get();
    const done = await through(name);
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toStartWith("/signup");
    expect(cookieOf(done, "forge_session")).toBe("");
    expect(getUserByName(child.db, name)).toBeUndefined();
    expect(child.db.query("SELECT COUNT(*) AS n FROM user").get()).toEqual(before);
  });
}

/** Each place in `src` that makes an account, and the origin it says. */
async function callers(): Promise<Record<string, string[]>> {
  const found: Record<string, string[]> = {};
  const root = join(import.meta.dir, "..");
  for await (const path of new Bun.Glob("src/**/*.ts").scan(root)) {
    const text = await Bun.file(join(root, path)).text();
    // Under another name a call would not be counted here.
    if (/createUser as /.test(text)) (found[path] ??= []).push("(renamed)");
    for (const at of text.matchAll(/(?<!function )\bcreateUser\(/g)) {
      let depth = 0;
      let end = at.index;
      for (; end < text.length; end++) {
        if (text[end] === "(") depth++;
        else if (text[end] === ")" && --depth === 0) break;
      }
      const origin = /origin: "([a-z-]+)"/.exec(text.slice(at.index, end))?.[1] ?? "(none)";
      (found[path] ??= []).push(origin);
    }
  }
  return found;
}

test("every caller of createUser says where its account comes from", async () => {
  // A new way in is added here on purpose: a stranger's door, or a named exemption.
  expect(await callers()).toEqual({
    "src/actions/crew.ts": ["agent"],
    "src/actions/first_admin.ts": ["first-admin"],
    "src/actions/spawn.ts": ["spawn", "spawn"],
    "src/actions/start.ts": ["start", "start"],
    "src/actions/users.ts": ["signup", "passkey"],
    "src/chaos/world.ts": ["seed"],
    "src/packs/mirror.ts": ["seed"],
    "src/packs/up.ts": ["seed"],
    "src/spawn/preview-seed.ts": ["seed", "seed", "seed"],
    "src/spawn/starter_crew.ts": ["spawn"],
    "src/web/pages/claim.ts": ["claim"],
    "src/web/pages/everyday.ts": ["everyday"],
    "src/web/pages/start_claim.ts": ["claimer"],
  });
});
