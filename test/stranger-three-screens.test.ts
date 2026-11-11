/**
 * The stranger's walk (#11242, acceptance of #11153): with no cookies, from `/`
 * to signed in on their own forge in at most three screens — the home page,
 * the new forge's claim form, the forge itself — and no link to copy. The
 * parent and the child it spawns both run for real; only the placement's
 * address is a stand-in, so each hop is followed by hand the way a browser does.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childDirOf, childNamed } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { WAIT_JS } from "../src/web/pages/new-forge.ts";
import { useProbe } from "../src/spawn/door.ts";
import { firstBoot } from "../src/spawn/first-boot.ts";
import { getUserByName } from "../src/core/users.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir = "";
let parent: App;
let parentServers: Servers;
let child: App | undefined;
let childServers: Servers | undefined;
let up = false;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-three-"));
  parent = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
  useProbe(parent, () => async () => up);
  parentServers = await serve(parent);
});
afterAll(async () => {
  childServers?.stop();
  child?.close();
  parentServers.stop();
  parent.close();
  await rm(dir, { recursive: true, force: true });
});

const start = (name: string) =>
  fetch(`${parentServers.url}/forges/new`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ name, from: "home" }),
    redirect: "manual",
  });

test("screen 1 to 2: a forge still booting shows a waiting page that goes on by itself, with no link to copy", async () => {
  up = false;
  const home = await (await fetch(`${parentServers.url}/`)).text();
  expect(home).toContain('id="start-forge"');
  const res = await start("walker");
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const body = await res.text();
  expect(body).toContain('id="making"');
  expect(body).toContain('data-name="walker"');
  expect(body).not.toContain("The link to send");
  expect(body).not.toContain("data-copy");
  // The only way on is one Continue link, always rendered (not only without JavaScript), to the claim form.
  const claims = body.match(/href="https:\/\/walker--forge\.test\/claim#[A-Za-z0-9_-]{43}"/g) ?? [];
  expect(claims).toHaveLength(1);
  expect(body).toMatch(/<a[^>]*id="making-go"[^>]*>\s*Continue/);
  expect(body).not.toContain("<noscript>");
});

/** Run the waiting script against stubs; `answers` is what each poll gets. */
function runWait(answers: Array<"pending" | "down">) {
  const status = { textContent: "", getAttribute: () => "walker" };
  const go = { href: "https://walker--forge.test/claim#x" };
  const replaced: string[] = [];
  let timers = 0;
  let n = 0;
  const fetchStub = () => {
    const a = answers[Math.min(n++, answers.length - 1)];
    return a === "down" ? Promise.reject(new Error("net")) : Promise.resolve({ json: async () => ({ ready: false }) });
  };
  const doc = { getElementById: (id: string) => (id === "making" ? status : go) };
  const timeout = (f: () => void) => { timers++; queueMicrotask(f); return 0; };
  new Function("document", "fetch", "setTimeout", "location", WAIT_JS)(doc, fetchStub, timeout, { replace: (u: string) => replaced.push(u) });
  return { status, replaced, polls: () => n, timers: () => timers };
}
const settle = () => new Promise((r) => setTimeout(r, 50));

test("the waiting script gives up after 120 tries and says so in plain words, never going on by itself", async () => {
  const w = runWait(["pending"]);
  await settle();
  expect(w.polls()).toBe(120);
  expect(w.status.textContent).toContain("taking longer than usual");
  expect(w.status.textContent).toContain("Continue");
  expect(w.replaced).toEqual([]);
});

test("a network error keeps trying and says the same when it gives up", async () => {
  const w = runWait(["down"]);
  await settle();
  expect(w.polls()).toBe(120);
  expect(w.status.textContent).toContain("taking longer than usual");
});

test("a name the door refuses still comes back to `/`, not to the waiting page", async () => {
  const res = await start("Bad_Name");
  expect(res.status).toBe(303);
  expect(res.headers.get("location") ?? "").toStartWith("/?start=");
});

test("screen 2 to 3: a forge that answers sends the browser to its claim form; a username and password land signed in as its admin", async () => {
  up = true;
  const res = await start("runner");
  expect(res.status).toBe(303);
  const to = res.headers.get("location") ?? "";
  expect(to).toMatch(/^https:\/\/runner--forge\.test\/claim#[A-Za-z0-9_-]{43}$/);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const token = to.split("#")[1] ?? "";

  const made = await childNamed(parent, "runner");
  if (made === undefined) throw new Error("no child");
  child = createApp({ dataDir: childDirOf(parent, made.bodyId), port: 0 });
  await firstBoot(child);
  childServers = await serve(child);

  const form = await fetch(`${childServers.url}/claim`);
  expect(form.status).toBe(200);
  const claimed = await fetch(`${childServers.url}/claim`, {
    method: "POST",
    headers: { origin: childServers.url },
    body: new URLSearchParams({ token, username: "walker-owner", password: "a-long-walker-passphrase" }),
    redirect: "manual",
  });
  expect(claimed.status).toBe(303);
  const cookie = (claimed.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  expect(cookie).not.toBe("");
  expect(getUserByName(child.db, "walker-owner")?.isAdmin).toBe(true);
  const landed = await fetch(`${childServers.url}${claimed.headers.get("location") ?? "/"}`, { headers: { cookie } });
  expect(landed.status).toBe(200);
  expect(await landed.text()).toContain("walker-owner");
});
