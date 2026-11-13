/**
 * The stranger's walk (#11242, acceptance of #11153): with no cookies, from `/`
 * to signed in on their own forge in at most three screens — the home page,
 * the new forge's account form, the forge itself. Between the first two, one
 * page says what is happening while the forge starts and hands over its link. The
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
import { madeBody, madeJs, madeWords } from "../src/web/forge_made.ts";
import { useProbe } from "../src/spawn/door.ts";
import { useReach } from "../src/spawn/reach.ts";
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

const start = (name: string, path = "/forges/start") =>
  fetch(`${parentServers.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ name }),
    redirect: "manual",
  });

/** The link the made page opens, read the way a browser would follow it. */
const linkOf = (body: string): string => /id="made-open"[^>]*href="([^"]+)"|href="([^"]+)"[^>]*id="made-open"/.exec(body)?.slice(1).find((x) => x !== undefined) ?? "";

test("screen 1 to 2: the answer is the one page that says what is happening and holds the link, never cached", async () => {
  up = false;
  const home = await (await fetch(`${parentServers.url}/`)).text();
  expect(home).toContain('id="start-forge"');
  const res = await start("walker");
  expect(res.status).toBe(200);
  expect(res.headers.get("location")).toBeNull();
  expect(res.headers.get("cache-control")).toBe("no-store");
  const body = await res.text();
  expect(body).toContain("walker is made and is starting. This usually takes about 15 seconds.");
  // Made for themselves: the account screen of their own forge, not the one for a link someone sent.
  expect(linkOf(body)).toMatch(/^https:\/\/walker--forge\.test\/welcome#[A-Za-z0-9_-]{43}$/);
  expect(body).toContain("Whoever holds this link owns the forge.");
  // A code a phone's camera opens, beside the link and a way to copy it.
  expect(body).toMatch(/<div class="to-phone[^"]*">[^]*<svg/);
  expect(body).toContain('data-copy="claim-link"');
});

test("the answer does not wait on the first reach proof: the page shows the start, the proof goes on behind it", async () => {
  const asked: string[] = [];
  useReach(parent, { fetch: async (url) => { asked.push(String(url)); await new Promise((r) => setTimeout(r, 400)); return new Response("{}", { status: 502 }); }, settleMs: 1, pollMs: 1 });
  const t0 = performance.now();
  const res = await start("quickly");
  await res.body?.cancel();
  expect(res.status).toBe(200);
  expect(performance.now() - t0).toBeLessThan(350);
  // Still proved, behind the answer.
  await new Promise((r) => setTimeout(r, 500));
  expect(asked.some((u) => u.includes("quickly--forge.test"))).toBe(true);
  useReach(parent, { off: true });
});

test("a signed-out /forges/new answers the same page (201); the home form and it carry no script flag", async () => {
  const res = await start("plainwalker", "/forges/new");
  expect(res.status).toBe(201);
  expect(res.headers.get("location")).toBeNull();
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(linkOf(await res.text())).toMatch(/^https:\/\/plainwalker--forge\.test\/welcome#[A-Za-z0-9_-]{43}$/);
  const home = await (await fetch(`${parentServers.url}/`)).text();
  expect(home).not.toContain("data-js");
});

/** Run the made page's script against stubs; `answers` is what each ask gets. `phone` is a narrow screen. */
function runMade(answers: Array<"starting" | "answering" | "down" | "ready">, o: { phone?: boolean; own?: boolean; clock?: () => number } = {}) {
  const words = madeWords("walker");
  const says = { textContent: words.starting as string };
  const link = { hidden: false };
  const open = { href: "https://walker--forge.test/welcome#code", focused: 0, focus() { this.focused++; } };
  const root = { getAttribute: (k: string) => (k === "data-name" ? "walker" : JSON.stringify(words)) };
  const replaced: string[] = [];
  let n = 0;
  const waits: number[] = [];
  const fetchStub = () => {
    const a = answers[Math.min(n++, answers.length - 1)];
    return a === "down" ? Promise.reject(new Error("net")) : Promise.resolve({ json: async () => ({ ready: a === "ready", step: a }) });
  };
  const doc = { getElementById: (id: string) => ({ made: root, "made-says": says, "made-link": link, "made-open": o.own === false ? null : open })[id] ?? null };
  const timeout = (f: () => void, ms: number) => { waits.push(ms); if (waits.length < 40) queueMicrotask(f); return 0; };
  const win = { fetch: fetchStub, matchMedia: () => ({ matches: o.phone === true }) };
  const date = { now: o.clock ?? (() => 0) };
  new Function("document", "window", "fetch", "setTimeout", "location", "matchMedia", "Date", madeJs)(doc, win, fetchStub, timeout, { replace: (u: string) => replaced.push(u) }, win.matchMedia, date);
  return { says, link, open, replaced, waits, asks: () => n, words };
}
const settle = () => new Promise((r) => setTimeout(r, 50));

test("the page says each real step as it comes, and shows the link the moment the forge answers", async () => {
  const w = runMade(["starting", "answering", "ready"]);
  expect(w.link.hidden).toBe(true);
  await settle();
  expect(w.asks()).toBe(3);
  expect(w.says.textContent).toBe("walker is ready.");
  expect(w.link.hidden).toBe(false);
  expect(w.open.focused).toBe(1);
  expect(w.replaced).toEqual([]);
  // Asked again a quarter of a second after each answer: the wait past the forge's own start is the poll, not seconds.
  expect(w.waits).toEqual([250, 250]);
});

test("while it runs but its address does not answer yet, the page says so", async () => {
  const w = runMade(["answering"]);
  await settle();
  expect(w.says.textContent).toBe("walker is running. Checking that its address answers.");
  expect(w.link.hidden).toBe(true);
});

test("on a phone, ready opens the forge: there is no other device to move to", async () => {
  const w = runMade(["ready"], { phone: true });
  await settle();
  expect(w.replaced).toEqual(["https://walker--forge.test/welcome#code"]);
});

test("a link to send is there from the start, and ready never opens it", async () => {
  const w = runMade(["starting", "ready"], { own: false, phone: true });
  expect(w.link.hidden).toBe(false);
  await settle();
  expect(w.says.textContent).toBe("walker is ready.");
  expect(w.replaced).toEqual([]);
});

test("a slow start or a dropped answer keeps asking, more slowly, and says it is taking longer", async () => {
  let t = 0;
  const w = runMade(["down", "starting"], { clock: () => (t += 20_000) });
  await settle();
  expect(w.says.textContent).toBe("walker is taking longer than usual. This page keeps checking.");
  expect(w.waits.at(-1)).toBe(2000);
  expect(w.link.hidden).toBe(true);
});

test("the made page escapes its name and link", () => {
  const out = madeBody({ name: '"><script>x</script>', link: 'https://x.test/welcome#"><img src=x onerror=1>', own: true }).text;
  expect(out).not.toContain("<script>x");
  expect(out).not.toContain("<img");
});

test("a name the door refuses still comes back to `/`, not to the waiting page", async () => {
  const res = await start("Bad_Name");
  expect(res.status).toBe(303);
  expect(res.headers.get("location") ?? "").toStartWith("/?start=");
});

test("screen 2 to 3: the made page hands on to the account form; a username and password land signed in as its admin", async () => {
  up = true;
  const res = await start("runner");
  expect(res.status).toBe(200);
  const token = linkOf(await res.text()).split("#")[1] ?? "";
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

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
