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
import { JS_FLAG_JS } from "../src/web/claim_code.ts";
import { WAITING_JS } from "../src/web/pages/forge-waiting.ts";
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

const start = (name: string, js = true, path = "/forges/start") =>
  fetch(`${parentServers.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(js ? { name, js: "1" } : { name }),
    redirect: "manual",
  });

test("screen 1 to 2: with JavaScript the answer is a 303 to the waiting page, the code only in the fragment", async () => {
  up = false;
  const home = await (await fetch(`${parentServers.url}/`)).text();
  expect(home).toContain('id="start-forge"');
  const res = await start("walker");
  expect(res.status).toBe(303);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("location") ?? "").toMatch(/^\/forges\/walker\/waiting#[A-Za-z0-9_-]{43}$/);
});

/** The text of every script a page loads from its own address. */
async function pageScripts(html: string): Promise<string> {
  const srcs = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]!);
  return (await Promise.all(srcs.map(async (u) => (await fetch(`${parentServers.url}${u}`)).text()))).join("\n");
}

test("the home form and /forges/new both carry data-js and load the script that adds js=1", async () => {
  const home = await (await fetch(`${parentServers.url}/`)).text();
  expect(home).toMatch(/<form[^>]*id="start-forge"[^>]*data-js/);
  expect(await pageScripts(home)).toContain("form[data-js]");
  const form = await (await fetch(`${parentServers.url}/forges/new`)).text();
  expect(form).toMatch(/<form[^>]*id="new-forge"[^>]*data-js/);
  expect(await pageScripts(form)).toContain("form[data-js]");
});

test("the flag script appends a hidden js=1 input to each data-js form", () => {
  const added: Array<{ type?: string; name?: string; value?: string }> = [];
  const form = { appendChild: (e: { type?: string; name?: string; value?: string }) => added.push(e) };
  const doc = { querySelectorAll: () => [form], createElement: () => ({}) };
  new Function("document", JS_FLAG_JS)(doc);
  expect(added).toEqual([{ type: "hidden", name: "js", value: "1" }]);
});

test("a claim code that is not well formed never goes in an address", async () => {
  const { waitingAddress } = await import("../src/web/claim_code.ts");
  expect(waitingAddress({ name: "walker", claimUrl: "https://walker--forge.test/claim#short" })).toBeUndefined();
  expect(waitingAddress({ name: "Bad_Name", claimUrl: `https://x/claim#${"a".repeat(43)}` })).toBeUndefined();
  expect(waitingAddress({ name: "walker", claimUrl: `https://x/claim#${"a".repeat(43)}` })).toBe(`/forges/walker/waiting#${"a".repeat(43)}`);
});

test("without JavaScript, /forges/new answers with the page (201) that shows the claim link once", async () => {
  const res = await start("plainwalker", false, "/forges/new");
  expect(res.status).toBe(201);
  expect(res.headers.get("location")).toBeNull();
  expect(res.headers.get("cache-control")).toBe("no-store");
  const body = await res.text();
  expect(body).toContain("The link to send");
  expect(body).toMatch(/plainwalker--forge\.test\/claim#[A-Za-z0-9_-]{43}/);
});

test("the waiting page is static and never contains the code", async () => {
  const page = await fetch(`${parentServers.url}/forges/walker/waiting`);
  expect(page.status).toBe(200);
  const body = await page.text();
  expect(body).not.toContain("/claim#");
  expect(body).toContain('data-claim="https://walker--forge.test/claim"');
  expect((await fetch(`${parentServers.url}/forges/Bad_Name/waiting`)).status).toBe(404);
});

/** Run the waiting script against stubs; `answers` is what each poll gets. */
function runWait(answers: Array<"pending" | "down" | "ready">) {
  const code = "a".repeat(43);
  const status = { textContent: "", getAttribute: (k: string) => (k === "data-name" ? "walker" : "https://walker--forge.test/claim") };
  const replaced: string[] = [];
  const cleared: string[] = [];
  let timers = 0;
  let n = 0;
  const fetchStub = () => {
    const a = answers[Math.min(n++, answers.length - 1)];
    return a === "down" ? Promise.reject(new Error("net")) : Promise.resolve({ json: async () => ({ ready: a === "ready" }) });
  };
  const doc = { getElementById: () => status };
  const timeout = (f: () => void) => { timers++; queueMicrotask(f); return 0; };
  new Function("document", "fetch", "setTimeout", "location", "history", WAITING_JS)(doc, fetchStub, timeout, { hash: `#${code}`, pathname: "/forges/walker/waiting", replace: (u: string) => replaced.push(u) }, { replaceState: (_a: unknown, _b: string, u: string) => cleared.push(u) });
  return { status, replaced, cleared, polls: () => n, timers: () => timers };
}
const settle = () => new Promise((r) => setTimeout(r, 50));

test("the waiting script gives up after 120 tries and says so in plain words, never going on by itself", async () => {
  const w = runWait(["pending"]);
  await settle();
  expect(w.polls()).toBe(120);
  expect(w.status.textContent).toContain("taking longer than usual");
  expect(w.cleared).toEqual(["/forges/walker/waiting"]);
  expect(w.replaced).toEqual([]);
});

test("a network error keeps trying and says the same when it gives up", async () => {
  const w = runWait(["down"]);
  await settle();
  expect(w.polls()).toBe(120);
  expect(w.status.textContent).toContain("taking longer than usual");
});

test("the waiting script goes to the child's claim form with the code once the forge answers", async () => {
  const w = runWait(["ready"]);
  await settle();
  expect(w.replaced).toEqual([`https://walker--forge.test/claim#${"a".repeat(43)}`]);
});

test("a name the door refuses still comes back to `/`, not to the waiting page", async () => {
  const res = await start("Bad_Name");
  expect(res.status).toBe(303);
  expect(res.headers.get("location") ?? "").toStartWith("/?start=");
});

test("screen 2 to 3: the waiting page hands on to the claim form; a username and password land signed in as its admin", async () => {
  up = true;
  const res = await start("runner");
  expect(res.status).toBe(303);
  const to = res.headers.get("location") ?? "";
  expect(to).toMatch(/^\/forges\/runner\/waiting#[A-Za-z0-9_-]{43}$/);
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
