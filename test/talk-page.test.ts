/**
 * /talk (#7652): the page renders the person's own history and a composer,
 * a reply streams over SSE and ends with the turn, resuming from a turn id;
 * a held action draws Confirm and Cancel that post the person's yes or no;
 * signed out goes to /signin; Talk is in the chrome, the palette and home;
 * a stream is capped per person; a once-result is never confirmed here.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { sayNo } from "../src/actions/conversation_confirms.ts";
import { clock, STREAMS_MAX } from "../src/web/pages/talk.ts";
import { appendTurn, listTurns, openConversation } from "../src/core/conversations.ts";
import { hold, waitingFor } from "../src/core/fence.ts";
import { getRepoById } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir: string;
let app: App;
let servers: Servers;
let alice: User;
let bob: User;

const cookie = (u: User) => `forge_session=${createSession(app.db, u.id).token}`;
const get = (path: string, u?: User, headers: Record<string, string> = {}) =>
  fetch(`${servers.url}${path}`, { redirect: "manual", headers: { ...(u ? { cookie: cookie(u) } : {}), ...headers } });
const post = (path: string, u: User, form: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch(`${servers.url}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { origin: servers.url, cookie: cookie(u), ...headers },
    body: new URLSearchParams(form),
  });
const say = (u: User, role: string, text: string) =>
  appendTurn(app.db, u.id, openConversation(app.db, u.id).id, { role, text });

/** The frames of a stream that ended on its own. */
async function frames(path: string, u: User, headers: Record<string, string> = {}) {
  const res = await get(path, u, headers);
  const text = await res.text();
  return text
    .split("\n\n")
    .map((f) => ({
      event: /^event: (.*)$/m.exec(f)?.[1],
      id: /^id: (.*)$/m.exec(f)?.[1],
      data: /^data: (.*)$/m.exec(f)?.[1],
    }))
    .filter((f) => f.event !== undefined);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-talk-page-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, first = false) => {
    const u = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first });
    if (!u.ok) throw new Error(u.error);
    promote(app.db, u.value);
    return u.value;
  };
  alice = await mk("alice", true);
  bob = await mk("bob");
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the page", () => {
  test("signed out goes to /signin and comes back", async () => {
    const res = await get("/talk");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toStartWith("/signin?next=%2Ftalk");
    expect((await get("/talk/stream")).status).toBe(401);
  });

  test("renders your history escaped, a composer, and keeps the log in order", async () => {
    say(alice, "person", "hello <b>there</b>");
    say(alice, "agent", "Hi **alice**");
    const res = await get("/talk", alice);
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("hello &lt;b&gt;there&lt;/b&gt;");
    expect(page).not.toContain("<b>there</b>");
    expect(page).toContain("<strong>alice</strong>");
    expect(page).toContain('action="/talk"');
    expect(page).toContain('name="text"');
    expect(page.indexOf("hello")).toBeLessThan(page.indexOf("Hi "));
    expect(res.headers.get("content-security-policy")).toBeTruthy();
  });

  test("each person has their own conversation", async () => {
    say(alice, "person", "alice-only secret");
    const bobs = await (await get("/talk", bob)).text();
    expect(bobs).not.toContain("alice-only secret");
    expect(bobs).toContain("Ask the forge anything");
  });

  test("a message with no agent running says so and is not kept", async () => {
    const res = await post("/talk", bob, { text: "do a thing" });
    expect(res.status).toBe(303);
    const after = await (await get("/talk", bob)).text();
    expect(after).not.toContain("do a thing");
    expect((await post("/talk", bob, { text: "x" }, { origin: "https://elsewhere.example" })).status).toBe(403);
    expect((await post("/talk", bob, { text: "  " })).status).toBe(303);
  });

  test("a message shows who and when, with a copy button; a tool call is a closed card; an empty chat offers starters", async () => {
    const carol = await createUser(app.db, { origin: "seed", trusted: true, username: "dana", email: "dana@forge.local", password: "a-good-passphrase" });
    if (!carol.ok) throw new Error(carol.error);
    promote(app.db, carol.value);
    const empty = await (await get("/talk", carol.value)).text();
    expect(empty).toContain('href="/talk?q=What%20needs%20my%20attention%3F"');
    expect(empty).not.toMatch(/<button[^>]*(data-suggest|data-copy|data-jump)/);
    say(carol.value, "person", "hi");
    say(carol.value, "agent", "hello");
    say(carol.value, "tool", "list_issues {\"repo\":\"x\"}");
    const page = await (await get("/talk", carol.value)).text();
    expect(page).not.toContain("data-suggest=");
    expect(page).toContain("You · <time");
    expect(page).toContain("Forge · <time");
    expect(page).not.toContain("data-copy");
    expect(page).toContain('role="log"');
    expect(page).toMatch(/<details><summary>list_issues /);
    expect(page).not.toMatch(/<details open/);
  });

  test("a suggestion link prefills the composer without the script, and only with a known suggestion", async () => {
    const q = "What needs my attention?";
    const page = await (await get(`/talk?q=${encodeURIComponent(q)}`, alice)).text();
    expect(page).toMatch(/<textarea[^>]*>What needs my attention\?<\/textarea>/);
    const other = await (await get(`/talk?q=${encodeURIComponent("<script>x</script>")}`, alice)).text();
    expect(other).not.toContain("<script>x</script>");
    expect(other).not.toMatch(/<textarea[^>]*>[^<]/);
  });

  describe("the script, driven against a DOM", () => {
    const boot = async (user = "u1", store: Record<string, string> = {}) => {
      const sources: Array<{ on: Record<string, (e: { data: string }) => void> }> = [];
      const { Window } = await import("happy-dom");
      const { talkJs } = await import("../src/web/pages/talk_client.ts");
      const window = new Window({ url: "http://localhost/talk" });
      const doc = window.document as any;
      doc.body.innerHTML = `<div class="talk" data-talk data-user="${user}" data-paged="0" data-running="1"><div>
        <ol class="talk-log" role="log" data-last=""><li class="talk-turn talk-agent" id="t-1"><div class="talk-body"><pre><code>let a = 1;</code></pre></div><p class="talk-meta">Forge · now</p></li></ol><div id="end"></div></div>
        <form class="talk-compose"><p class="talk-status" role="status"></p><textarea name="text"></textarea><span data-hint></span></form></div>`;
      const sent: string[] = [];
      const copied: string[] = [];
      const fetchStub = async (_u: string, init: { body: string }) => { sent.push(JSON.parse(init.body).text); return { ok: true, json: async () => ({}) }; };
      const local = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: (k: string) => { delete store[k]; } };
      const nav = { clipboard: { writeText: async (t: string) => { copied.push(t); } } };
      class ES { on: Record<string, (e: { data: string }) => void> = {}; constructor() { sources.push(this); } addEventListener(n: string, f: (e: { data: string }) => void) { this.on[n] = f; } close() {} }
      doc.getElementById("end").scrollIntoView = () => {};
      new Function("document", "window", "EventSource", "fetch", "localStorage", "navigator", talkJs)(doc, window, ES, fetchStub, local, nav);
      const box = doc.querySelector("textarea");
      const key = (init: object) => box.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }));
      const emit = (id: string, html: string) => sources.at(-1)!.on["turn"]!({ data: JSON.stringify({ id, html }) });
      return { emit, window, doc, box, sent, copied, store, key, status: doc.querySelector(".talk-status") };
    };
    const tick = () => new Promise((r) => setTimeout(r, 5));

    test("Enter submits; Shift+Enter and an IME composition do not", async () => {
      const t = await boot();
      t.box.value = "hello";
      expect(t.key({ shiftKey: true })).toBe(true);
      expect(t.key({ isComposing: true })).toBe(true);
      await tick();
      expect(t.sent).toEqual([]);
      expect(t.key({})).toBe(false);
      await tick();
      expect(t.sent).toEqual(["hello"]);
      expect(t.doc.querySelector("[data-hint]").textContent).toContain("Enter sends");
      await t.window.happyDOM.close();
    });

    test("the draft is stored per person on input, restored on load, and cleared on send", async () => {
      const t = await boot("u1");
      t.box.value = "half";
      t.box.dispatchEvent(new t.window.Event("input", { bubbles: true }));
      expect(t.store["talk-draft:u1"]).toBe("half");
      const again = await boot("u1", t.store);
      expect(again.box.value).toBe("half");
      const other = await boot("u2", t.store);
      expect(other.box.value).toBe("");
      again.key({});
      await tick();
      expect(again.store["talk-draft:u1"]).toBeUndefined();
    });

    test("copy buttons are drawn by the script, code first in tab order, and copy the text", async () => {
      const t = await boot();
      const pre = t.doc.querySelector("pre");
      expect(pre.firstElementChild.getAttribute("data-copy")).toBe("");
      expect(t.doc.querySelector(".talk-meta [data-copy]")).not.toBeNull();
      pre.firstElementChild.dispatchEvent(new t.window.MouseEvent("click", { bubbles: true }));
      await tick();
      expect(t.copied).toEqual(["let a = 1;"]);
    });

    test("a code block in a streamed turn gets its Copy button too", async () => {
      const t = await boot();
      t.emit("2", '<li class="talk-turn" id="t-2"><div class="talk-body"><pre><code>x</code></pre></div><p class="talk-meta">Forge</p></li>');
      expect(t.doc.querySelectorAll("#t-2 pre [data-copy]").length).toBe(1);
      expect(t.doc.querySelectorAll("#t-2 .talk-meta [data-copy]").length).toBe(1);
    });

    test("the jump button shows only when scrolled up, and a new message is announced", async () => {
      const t = await boot();
      const jump = t.doc.querySelector(".talk-jump");
      t.emit("2", '<li class="talk-turn" id="t-2">a</li>');
      expect(jump.hidden).toBe(true);
      expect(t.status.textContent).not.toContain("New message");
      Object.defineProperty(t.window, "innerHeight", { value: 800, configurable: true });
      Object.defineProperty(t.window, "scrollY", { value: 0, configurable: true });
      Object.defineProperty(t.doc.documentElement, "scrollHeight", { value: 5000, configurable: true });
      t.window.dispatchEvent(new t.window.Event("scroll"));
      t.emit("3", '<li class="talk-turn" id="t-3">b</li>');
      expect(jump.hidden).toBe(false);
      expect(t.status.textContent).toBe("New message");
      Object.defineProperty(t.window, "scrollY", { value: 4400, configurable: true });
      t.window.dispatchEvent(new t.window.Event("scroll"));
      expect(jump.hidden).toBe(true);
    });
  });

  test("Talk is one tap away: the chrome, the palette and home", async () => {
    const home = await (await get("/explore", alice)).text();
    expect(home).toContain('href="/talk"');
    expect(home).toContain('aria-label="Talk to the forge"');
    expect(home).toContain('"h":"/talk"');
  });
});

describe("the stream", () => {
  test("replays turns after an id, then ends with the turn", async () => {
    const a = say(bob, "person", "first");
    const b = say(bob, "agent", "second");
    if (!a.ok || !b.ok) throw new Error("turns");
    const all = await frames("/talk/stream?after=", bob);
    expect(all.map((f) => f.event)).toEqual(["turn", "turn", "done"]);
    expect(all[0]!.id).toBe(a.value.id);
    expect(JSON.parse(all[1]!.data!).html).toContain("second");
    const rest = await frames(`/talk/stream?after=${a.value.id}`, bob);
    expect(rest.map((f) => f.id ?? f.event)).toEqual([b.value.id, "done"]);
    // A reconnect that names the last turn it saw gets only what is new.
    const resumed = await frames("/talk/stream", bob, { "last-event-id": b.value.id });
    expect(resumed.map((f) => f.event)).toEqual(["done"]);
  });

  test("never shows another person's turns, and refuses a bad id", async () => {
    const mine = say(bob, "agent", "bob private");
    if (!mine.ok) throw new Error("turn");
    const theirs = await frames(`/talk/stream?after=${mine.value.id}`, alice);
    expect(theirs.map((f) => f.event)).toEqual(["done"]);
    const seen = await frames("/talk/stream?after=", alice);
    expect(JSON.stringify(seen)).not.toContain("bob private");
    expect((await get("/talk/stream?after=%3Cscript%3E", alice)).status).toBe(400);
  });
});

describe("confirm and cancel", () => {
  async function held(u: User) {
    const made = await createRepo(app, u, { name: `r${Math.random().toString(36).slice(2, 8)}`, visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const id = hold(app.db, "conversation:talk", u.id, "archive", { repo: `${u.username}/${made.value.name}`, archived: true, dryRun: false });
    if (id === null) throw new Error("hold");
    say(u, "confirm", JSON.stringify({ confirm: id, tool: "archive", does: "This will archive the app." }));
    return { id, repoId: made.value.id };
  }

  test("a waiting confirm draws Confirm and Cancel; Cancel does nothing and cannot be undone by a yes", async () => {
    const h = await held(alice);
    const page = await (await get("/talk", alice)).text();
    expect(page).toContain("This will archive the app.");
    expect(page).toContain(`action="/talk/confirm/${h.id}"`);
    expect(page).toContain("Confirm");
    expect(page).toContain("Cancel");
    const no = await post(`/talk/confirm/${h.id}`, alice, { answer: "no" }, { accept: "application/json" });
    expect(no.status).toBe(200);
    expect(getRepoById(app.db, h.repoId)!.archivedAt).toBeNull();
    const yes = await post(`/talk/confirm/${h.id}`, alice, { answer: "yes" }, { accept: "application/json" });
    expect(yes.status).toBe(409);
    expect(getRepoById(app.db, h.repoId)!.archivedAt).toBeNull();
    const after = await (await get("/talk", alice)).text();
    expect(after).toContain("Cancelled: archive.");
    expect(after).not.toContain(`action="/talk/confirm/${h.id}"`);
  });

  test("Confirm does the stored call once", async () => {
    const h = await held(alice);
    const yes = await post(`/talk/confirm/${h.id}`, alice, { answer: "yes" }, { accept: "application/json" });
    expect(yes.status).toBe(200);
    expect(getRepoById(app.db, h.repoId)!.archivedAt).not.toBeNull();
    expect((await post(`/talk/confirm/${h.id}`, alice, { answer: "yes" }, { accept: "application/json" })).status).toBe(409);
    expect(await (await get("/talk", alice)).text()).toContain("Done: archive.");
  });

  test("nobody else's yes or no counts, nor a cross-origin one, nor a bad answer", async () => {
    const h = await held(alice);
    expect((await post(`/talk/confirm/${h.id}`, bob, { answer: "yes" }, { accept: "application/json" })).status).toBe(404);
    expect((await post(`/talk/confirm/${h.id}`, bob, { answer: "no" }, { accept: "application/json" })).status).toBe(404);
    expect((await post(`/talk/confirm/${h.id}`, alice, { answer: "yes" }, { origin: "https://elsewhere.example" })).status).toBe(403);
    expect((await post(`/talk/confirm/${h.id}`, alice, { answer: "maybe" })).status).toBe(400);
    expect(getRepoById(app.db, h.repoId)!.archivedAt).toBeNull();
  });
});

describe("a once-result", () => {
  test("a yes posted here is refused, runs nothing and keeps the confirm for Settings", async () => {
    const id = hold(app.db, "conversation:talk", alice.id, "mint_invite", {});
    if (id === null) throw new Error("hold");
    say(alice, "confirm", JSON.stringify({ confirm: id, tool: "mint_invite", does: "This will mint an invite." }));
    const page = await (await get("/talk", alice)).text();
    expect(page).toContain(`action="/settings/confirms/${id}"`);
    const yes = await post(`/talk/confirm/${id}`, alice, { answer: "yes" }, { accept: "application/json" });
    expect(yes.status).toBe(409);
    expect(((await yes.json()) as { message: string }).message).toContain("Settings");
    expect(waitingFor(app.db, alice.id).some((h) => h.id === id)).toBe(true);
    // Cancel is still allowed here.
    expect((await post(`/talk/confirm/${id}`, alice, { answer: "no" }, { accept: "application/json" })).status).toBe(200);
  });
});

describe("sayNo", () => {
  test("spends the confirm, writes a cancelled tool turn, and is not another person's to say", () => {
    const id = hold(app.db, "conversation:talk", bob.id, "archive", { repo: "bob/none", archived: true, dryRun: false });
    if (id === null) throw new Error("hold");
    expect(sayNo({ app }, alice, id)).toEqual({ ok: false, error: "not_found" });
    const no = sayNo({ app }, bob, id);
    expect(no.ok).toBe(true);
    expect(sayNo({ app }, bob, id)).toEqual({ ok: false, error: "answered" });
    const turns = listTurns(app.db, bob.id, openConversation(app.db, bob.id).id, { limit: 200 });
    if (!turns.ok) throw new Error("turns");
    const last = JSON.parse(turns.value.at(-1)!.text);
    expect(last).toMatchObject({ confirm: id, tool: "archive", done: false, cancelled: true });
    expect(sayNo({ app }, bob, "../x")).toEqual({ ok: false, error: "not_found" });
  });
});

describe("paging back", () => {
  test("?before= shows older turns, does not follow, and validates the id", async () => {
    const carol = await createUser(app.db, { origin: "seed", trusted: true, username: "carol", email: "carol@forge.local", password: "a-good-passphrase" });
    if (!carol.ok) throw new Error("user");
    promote(app.db, carol.value);
    let ids: string[] = [];
    for (let i = 0; i < 55; i++) {
      const t = say(carol.value, "person", `turn-${String(i).padStart(2, "0")}`);
      if (t.ok) ids.push(t.value.id);
    }
    const first = await (await get("/talk", carol.value)).text();
    expect(first).toContain("turn-54");
    expect(first).not.toContain("turn-04");
    expect(first).toContain('data-paged="0"');
    const link = /href="\/talk\?before=([0-9a-z]+)"/.exec(first);
    expect(link).not.toBeNull();
    clock.running = () => true;
    try {
      const older = await (await get(`/talk?before=${link![1]}`, carol.value)).text();
      expect(older).toContain("turn-04");
      expect(older).not.toContain("turn-54");
      expect(older).toContain('data-paged="1"');
      expect(older).toContain('data-running="0"');
      const latest = await (await get("/talk", carol.value)).text();
      expect(latest).toContain('data-running="1"');
    } finally {
      clock.running = (await import("../src/crew/conversation.ts")).turnRunning;
    }
    // A bad id is ignored, not echoed.
    const bad = await get("/talk?before=%3Cscript%3E", carol.value);
    expect(bad.status).toBe(200);
    expect(await bad.text()).not.toContain("<script>alert");
  });
});

describe("a long stream", () => {
  test("while a turn runs it says running, then asks the client to reconnect", async () => {
    const { turnRunning } = await import("../src/crew/conversation.ts");
    clock.running = () => true;
    clock.streamMs = 700;
    try {
      const seen = await frames("/talk/stream?after=", alice);
      const events = seen.map((f) => f.event);
      expect(events.at(-1)).toBe("more");
      expect(events).toContain("running");
      expect(events).not.toContain("done");
    } finally {
      clock.running = turnRunning;
      clock.streamMs = 40_000;
    }
  });

  test("a person holds at most STREAMS_MAX at once; the next waits, and a slot frees", async () => {
    const { turnRunning } = await import("../src/crew/conversation.ts");
    clock.running = () => true;
    clock.streamMs = 60_000;
    const aborts = Array.from({ length: STREAMS_MAX }, () => new AbortController());
    try {
      const open = await Promise.all(aborts.map((a) => fetch(`${servers.url}/talk/stream?after=`, { headers: { cookie: cookie(bob) }, signal: a.signal })));
      expect(open.map((r) => r.status)).toEqual(Array(STREAMS_MAX).fill(200));
      const extra = await get("/talk/stream?after=", bob);
      expect(extra.status).toBe(429);
      expect(extra.headers.get("retry-after")).toBeTruthy();
      // Another person is not held back.
      const other = new AbortController();
      expect((await fetch(`${servers.url}/talk/stream?after=`, { headers: { cookie: cookie(alice) }, signal: other.signal })).status).toBe(200);
      other.abort();
      aborts[0]!.abort();
      await new Promise((r) => setTimeout(r, 300));
      const again = new AbortController();
      expect((await fetch(`${servers.url}/talk/stream?after=`, { headers: { cookie: cookie(bob) }, signal: again.signal })).status).toBe(200);
      again.abort();
    } finally {
      for (const a of aborts) a.abort();
      clock.running = turnRunning;
      clock.streamMs = 40_000;
      await new Promise((r) => setTimeout(r, 300));
    }
  });
});
