/**
 * The composer keeps what you typed (#5913): saved per user and page, put
 * back on load, dropped once the tell is sent, kept when it is refused, and
 * gone at sign-out. The browser test drives a real Chromium through
 * type, reload, send, reload.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { findChromium } from "../src/looks/capture.ts";
import { withPage } from "../src/release/devtools.ts";
import { draftJs } from "../src/web/draft.ts";
import { feedJs } from "../src/web/studio/feed.ts";
import { promote } from "./helpers/members.ts";

let app: App;
let servers: Servers;
let alice: User;
let cookie: string;

beforeAll(async () => {
  app = createApp({ dataDir: await mkdtemp(join(tmpdir(), "draft.")), port: 0 });
  servers = await serve(app);
  const mk = async (username: string, first = false) => {
    const r = await createUser(app.db, {
      origin: "seed", trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", adminIfFirst: first,
    });
    if (!r.ok) throw new Error(r.error);
    promote(app.db, r.value);
    return r.value;
  };
  await mk("keeper", true);
  alice = await mk("alice");
  cookie = createSession(app.db, alice.id).token;
  const g = await createRepo(app, alice, { name: "garden", visibility: "public" });
  if (!g.ok) throw new Error("repo");
  insertApp(app.db, { repoId: g.value.id, slug: "garden", access: "public" });
});
afterAll(() => servers.stop());

test("the composer names its user for the draft key, and the script stays small", async () => {
  const res = await fetch(`${servers.url}/feed`, { headers: { cookie: `forge_session=${cookie}; forge_mode=studio` } });
  const page = await res.text();
  expect(page).toContain(`data-draft="${alice.id}"`);
  expect(feedJs).toContain("forgeDraft(");
});

type Draft = {
  restore(): void; typed(): void; refused(text: string): void; clear(): void; forgetAll(): void;
};
const makeDraft = new Function(`${draftJs}; return forgeDraft;`)() as (
  storage: Storage, box: { value: string }, key: string, later: (fn: () => void, ms: number) => void,
) => Draft;
const memory = (): Storage => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  } as Storage;
};
const rig = () => {
  const store = memory();
  const box = { value: "" };
  const timers: Array<() => void> = [];
  const draft = makeDraft(store, box, "draft.u1/", (fn, ms) => { expect(ms).toBe(1000); timers.push(fn); });
  return { store, box, timers, draft };
};

test("typing is saved once per burst, after the delay", () => {
  const { store, box, timers, draft } = rig();
  box.value = "Wa"; draft.typed();
  box.value = "Water"; draft.typed();
  expect(timers.length).toBe(1);
  expect(store.getItem("draft.u1/")).toBeNull();
  timers.shift()!();
  expect(store.getItem("draft.u1/")).toBe("Water");
  box.value = "Water it"; draft.typed();
  expect(timers.length).toBe(1);
});

test("a saved draft is put back into an empty box, never over typed words", () => {
  const { store, box, draft } = rig();
  store.setItem("draft.u1/", "saved");
  draft.restore();
  expect(box.value).toBe("saved");
  box.value = "newer";
  draft.restore();
  expect(box.value).toBe("newer");
});

test("clearing drops the saved draft; an emptied box saves as nothing", () => {
  const { store, box, timers, draft } = rig();
  store.setItem("draft.u1/", "saved");
  draft.clear();
  expect(store.getItem("draft.u1/")).toBeNull();
  box.value = "x"; draft.typed(); timers.shift()!();
  box.value = ""; draft.typed(); timers.shift()!();
  expect(store.getItem("draft.u1/")).toBeNull();
});

test("clearing cancels a save still waiting, so sent words are not saved back", () => {
  const { store, box, timers, draft } = rig();
  box.value = "sent"; draft.typed();
  draft.clear();
  timers.shift()!();
  expect(store.getItem("draft.u1/")).toBeNull();
  draft.typed();
  expect(timers.length).toBe(1);
});

test("a refused send gives the words back, but not over what was typed since", () => {
  const a = rig();
  a.draft.refused("Mulch first");
  expect(a.box.value).toBe("Mulch first");
  expect(a.store.getItem("draft.u1/")).toBe("Mulch first");
  const b = rig();
  b.box.value = "Something new";
  b.draft.refused("Mulch first");
  expect(b.box.value).toBe("Something new");
  expect(b.store.getItem("draft.u1/")).toBe("Something new");
});

test("forgetting removes every draft and nothing else", () => {
  const { store, draft } = rig();
  store.setItem("draft.u1/", "a");
  store.setItem("draft.u2/studio", "b");
  store.setItem("forge.outbox", "[]");
  draft.forgetAll();
  expect(store.getItem("draft.u1/")).toBeNull();
  expect(store.getItem("draft.u2/studio")).toBeNull();
  expect(store.getItem("forge.outbox")).toBe("[]");
});

const noChromium = findChromium() === undefined;

test.skipIf(noChromium)("in a real browser: type, reload, find it; send, reload, find it empty; a refusal keeps it; sign-out clears it", async () => {
  const bin = findChromium()!;
  await withPage(bin, async (send, once) => {
    await send("Page.enable");
    await send("Network.setCookie", { name: "forge_session", value: cookie, url: servers.url });
    await send("Network.setCookie", { name: "forge_mode", value: "studio", url: servers.url });
    const load = async () => {
      const loaded = once("Page.loadEventFired");
      loaded.catch(() => {});
      await send("Page.navigate", { url: `${servers.url}/feed` });
      await loaded;
      await waitFor(`!!document.getElementById("composer")`);
    };
    const run = async (expression: string) => {
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "evaluate failed");
      return r.result.value;
    };
    const waitFor = async (expression: string) => {
      const until = Date.now() + 8000;
      while (Date.now() < until) {
        if (await run(expression)) return;
        await Bun.sleep(25);
      }
      throw new Error(`timed out waiting for ${expression}`);
    };
    const box = `document.getElementById("composer").elements.text`;
    const type = (text: string) =>
      run(`(() => { const b = ${box}; b.value = ${JSON.stringify(text)}; b.dispatchEvent(new Event("input", { bubbles: true })); })()`);

    await load();
    await type("Water the tomatoes at dawn");
    await waitFor(`localStorage.getItem(${JSON.stringify(`draft.${alice.id}/feed`)}) === "Water the tomatoes at dawn"`);
    await load();
    expect(await run(`${box}.value`)).toBe("Water the tomatoes at dawn");

    // Sending clears it.
    await run(`(() => { document.getElementById("composer").elements.app.value = "alice/garden"; document.getElementById("composer").requestSubmit(); })()`);
    await waitFor(`${box}.value === "" && !Object.keys(localStorage).some(k => k.startsWith("draft."))`);
    await waitFor(`!localStorage.getItem("forge.outbox") || localStorage.getItem("forge.outbox") === "[]"`);
    await load();
    expect(await run(`${box}.value`)).toBe("");
    expect(await run(`Object.keys(localStorage).filter(k => k.startsWith("draft."))`)).toEqual([]);

    // Sending to the forge posts the form natively: the draft must not come back.
    await run(`(() => { const c = document.getElementById("composer"); c.elements.text.value = "Plant beans"; c.elements.text.dispatchEvent(new Event("input", { bubbles: true })); c.elements.app.value = "forge"; })()`);
    const navigated = once("Page.loadEventFired");
    navigated.catch(() => {});
    await run(`document.getElementById("composer").requestSubmit()`);
    await navigated;
    await waitFor(`!!document.getElementById("composer")`);
    await Bun.sleep(1200); // a stale save would have fired by now
    expect(await run(`${box}.value`)).toBe("");
    expect(await run(`Object.keys(localStorage).filter(k => k.startsWith("draft."))`)).toEqual([]);

    // A refused send (the app is gone) keeps the words.
    await type("Mulch first");
    await run(`(() => { const c = document.getElementById("composer"); const o = document.createElement("option"); o.value = "alice/nowhere"; c.elements.app.append(o); c.elements.app.value = "alice/nowhere"; c.requestSubmit(); })()`);
    await waitFor(`!localStorage.getItem("forge.outbox") || localStorage.getItem("forge.outbox") === "[]"`);
    await waitFor(`localStorage.getItem(${JSON.stringify(`draft.${alice.id}/feed`)}) === "Mulch first"`);
    expect(await run(`${box}.value`)).toBe("Mulch first");
    await load();
    expect(await run(`${box}.value`)).toBe("Mulch first");

    // Signing out clears every saved draft.
    await run(`document.querySelector('form[action="/logout"]').requestSubmit()`);
    await waitFor(`!Object.keys(localStorage).some(k => k.startsWith("draft."))`);
  });
}, 90000);

test.skipIf(!noChromium)("no chromium on this machine: the composer draft browser test did not run", () => {});

test("a tell sent from the feed's composer comes back to the feed, the forge's too", async () => {
  // Its own session: the browser test before it signs its session out.
  const cookie = createSession(app.db, alice.id).token;
  const page = await (await fetch(`${servers.url}/feed`, { headers: { cookie: `forge_session=${cookie}; forge_mode=studio` } })).text();
  expect(page).toContain('name="back" value="/feed"');
  for (const app of ["forge", "alice/garden"]) {
    const res = await fetch(`${servers.url}/tell`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: `forge_session=${cookie}; forge_mode=studio`, origin: servers.url, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ app, text: "Plant beans", back: "/feed" }),
    });
    expect(res.status).toBeLessThan(400);
    expect(new URL(res.headers.get("location") ?? "", servers.url).pathname).toBe("/feed");
  }
});
