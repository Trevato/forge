/**
 * /talk (#7652): the page renders the person's own history and a composer,
 * a reply streams over SSE and ends with the turn, resuming from a turn id;
 * a held action draws Confirm and Cancel that post the person's yes or no;
 * signed out goes to /signin; Talk is in the chrome, the palette and home;
 * a stream is capped per person; a once-result is never confirmed here.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { sayNo, sayYes } from "../src/actions/conversation_confirms.ts";
import { openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { clock, STREAMS_MAX } from "../src/web/pages/talk.ts";
import { addSubscription, setGrants } from "../src/core/subscriptions.ts";
import { serveTalk } from "../src/tui/ssh-talk.ts";
import { aboutContext, aboutLine, parseAbout } from "../src/core/talk_about.ts";
import { talk as talkTo } from "../src/actions/talk.ts";
import { configureConversation } from "../src/crew/conversation.ts";
import { appendTurn, createConversation, listTurns, openConversation } from "../src/core/conversations.ts";
import { HELD_TTL_MS, hold, waitingFor } from "../src/core/fence.ts";
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
  test("the conversations are rows and no turn sits in a box (#9690)", async () => {
    say(alice, "person", "hi");
    const html = await (await get("/talk", alice)).text();
    expect(html).toContain('<h1 class="sr-only">Talk</h1>');
    expect(html).not.toContain('class="page-head"');
    const nav = html.slice(html.indexOf('<nav class="talk-chats"'), html.indexOf("</nav>"));
    expect(nav).toContain('<ul class="list">');
    const { talkCss } = await import("../src/web/pages/talk_client.ts");
    const rule = (sel: string) => talkCss.match(new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1];
    expect(rule(".talk-person")).toBeDefined();
    expect(rule(".talk-person")).not.toMatch(/border|background/);
    expect(rule(".talk-confirm")).toBeDefined();
    expect(rule(".talk-confirm")).not.toMatch(/border|background/);
    expect(rule(".talk-queued")).toBeDefined();
    expect(rule(".talk-queued")).not.toContain("border-style");
    expect(talkCss).not.toMatch(/\.talk-tool details\s*\{[^}]*border/);
    expect(talkCss).not.toMatch(/\.talk-chats ul\s*\{/);
  });

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
    expect(page).toMatch(/<details><summary>List issues /);
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

  test("markdown in a reply: highlighted code, a table and a link render; every <script> is escaped", async () => {
    const eve = await createUser(app.db, { origin: "seed", trusted: true, username: "eve", email: "eve@forge.local", password: "a-good-passphrase" });
    if (!eve.ok) throw new Error(eve.error);
    promote(app.db, eve.value);
    say(eve.value, "agent", [
      "Plain <script>alert(1)</script> and [docs](/docs) and [bad](javascript:alert(1))",
      "",
      "```ts",
      "const s = \"<script>alert(2)</script>\";",
      "```",
      "",
      "| name | note |",
      "| --- | ---: |",
      "| a | <script>alert(3)</script> |",
    ].join("\n"));
    const page = await (await get("/talk", eve.value)).text();
    expect(page).not.toContain("<script>alert");
    expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(page).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
    expect(page).toContain("<td class=\"ta-r\">&lt;script&gt;alert(3)&lt;/script&gt;</td>");
    expect(page).toMatch(/<pre><code class="language-ts">.*tok-keyword/s);
    expect(page).toContain('<a href="/docs" rel="nofollow noopener">docs</a>');
    expect(page).not.toContain('href="javascript:');
    expect(page).toContain("<table>");
  });

  test("an unfinished code block closes itself and leaves what is above it as it was", async () => {
    const { turnHtml } = await import("../src/web/pages/talk.ts");
    const turn = (text: string) => ({ id: "9", role: "agent", text, createdAt: "2026-01-01T00:00:00Z" }) as any;
    const above = "Intro **bold**\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n";
    const part = turnHtml(turn(`${above}\`\`\`ts\nconst a = 1;\nconst b`), new Set()).text;
    const whole = turnHtml(turn(`${above}\`\`\`ts\nconst a = 1;\nconst b = 2;\n\`\`\`\n\nDone.`), new Set()).text;
    const head = (h: string) => h.slice(0, h.indexOf("<pre>"));
    expect(head(part)).toBe(head(whole));
    expect(part.match(/<pre>/g)?.length).toBe(1);
    expect(part).toContain("</code></pre>");
  });

  test("an agent turn carries no prose padding or measure into the column", async () => {
    const { talkCss } = await import("../src/web/pages/talk_client.ts");
    expect(talkCss).toContain(".talk-body.prose { padding: 0;");
    expect(talkCss).toContain(".talk-body.prose > * { max-width: none; }");
  });

  test("the page's own bytes are held: stylesheet and script stay small", async () => {
    const { talkCss, talkJs } = await import("../src/web/pages/talk_client.ts");
    expect(Buffer.byteLength(talkCss)).toBeLessThan(4_050);
    expect(Buffer.byteLength(talkJs)).toBeLessThan(14_000);
    say(alice, "agent", "```ts\nlet x = 1;\n```");
    const page = await get("/talk", alice);
    const size = (await page.arrayBuffer()).byteLength;
    expect(size).toBeLessThan(40_000);
  });

  describe("the script, driven against a DOM", () => {
    test("while a reply streams the composer stays open: Send queues, Steer and Stop appear, Escape stops, and it is Send again when the turn ends", async () => {
      const t = await boot();
      const send = t.doc.querySelector('.bar button[type="submit"]');
      const stop = t.doc.querySelector("[data-stop]");
      expect(send.textContent).toBe("Send");
      expect(stop.hidden).toBe(true);
      t.sources.at(-1)!.on["running"]!({ data: "{}" });
      expect(send.textContent).toBe("Queue");
      expect(stop.hidden).toBe(false);
      stop.dispatchEvent(new t.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      t.doc.dispatchEvent(new t.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      expect(t.urls).toEqual(["/api/v1/conversation/stop", "/api/v1/conversation/stop"]);
      t.sources.at(-1)!.on["done"]!({ data: "{}" });
      expect(send.textContent).toBe("Send");
      expect(stop.hidden).toBe(true);
      t.doc.dispatchEvent(new t.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      expect(t.urls).toHaveLength(2);
    });

    const queuedFrame = (id: string, text: string) => ({ id, html: `<li class="talk-turn talk-queued" data-queued="${id}"><div class="talk-body">${text}</div><form data-unqueue method="post" action="/talk/queue/${id}/cancel"><button>Cancel</button></form></li>` });

    test("a message sent mid-answer is queued; the stream's queued frame draws it; Cancel puts it back without overwriting what is typed (#8819)", async () => {
      const t = await boot();
      t.how.value = "queued";
      t.sources.at(-1)!.on["running"]!({ data: "{}" });
      t.box.value = "and then this";
      t.key({});
      await tick();
      expect(t.bodies.at(-1)).toMatchObject({ text: "and then this", during: "queue" });
      expect(t.status.textContent).toContain("Queued");
      t.sources.at(-1)!.on["queued"]!({ data: JSON.stringify({ items: [queuedFrame("q1", "and then this")] }) });
      t.sources.at(-1)!.on["queued"]!({ data: JSON.stringify({ items: [queuedFrame("q1", "and then this")] }) });
      expect(t.doc.querySelectorAll("[data-queued]")).toHaveLength(1);
      t.box.value = "something new";
      t.doc.querySelector("form[data-unqueue]").dispatchEvent(new t.window.Event("submit", { bubbles: true, cancelable: true }));
      await tick();
      expect(t.urls.at(-1)).toEndWith("/talk/queue/q1/cancel");
      expect(t.doc.querySelector("[data-queued]")).toBeNull();
      expect(t.box.value).toBe("something new\nand then this");
    });

    test("Cancel keeps the message when the server fails and drops it only on a 404; Steer sends a steer", async () => {
      const t = await boot();
      t.sources.at(-1)!.on["running"]!({ data: "{}" });
      t.sources.at(-1)!.on["queued"]!({ data: JSON.stringify({ items: [queuedFrame("q1", "keep me")] }) });
      t.cancel.status = 500;
      t.doc.querySelector("form[data-unqueue]").dispatchEvent(new t.window.Event("submit", { bubbles: true, cancelable: true }));
      await tick();
      expect(t.doc.querySelector("[data-queued]")).not.toBeNull();
      t.cancel.status = 404;
      t.doc.querySelector("form[data-unqueue]").dispatchEvent(new t.window.Event("submit", { bubbles: true, cancelable: true }));
      await tick();
      expect(t.doc.querySelector("[data-queued]")).toBeNull();
      t.box.value = "do this instead";
      t.doc.querySelector("[data-steer]").dispatchEvent(new t.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await tick();
      expect(t.bodies.at(-1)).toMatchObject({ text: "do this instead", during: "steer" });
    });

    const boot = async (user = "u1", store: Record<string, string> = {}) => {
      const sources: Array<{ on: Record<string, (e: { data: string }) => void> }> = [];
      const { Window } = await import("happy-dom");
      const { talkJs } = await import("../src/web/pages/talk_client.ts");
      const window = new Window({ url: "http://localhost/talk" });
      const doc = window.document as any;
      doc.body.innerHTML = `<div class="talk" data-talk data-user="${user}" data-paged="0" data-running="1"><div>
        <ol class="talk-log" role="log" data-last=""><li class="talk-turn talk-agent" id="t-1"><div class="talk-body"><pre><code>let a = 1;</code></pre></div><p class="talk-meta">Forge · now</p></li></ol><div id="end"></div></div>
        <form class="talk-compose"><p class="talk-status" role="status"></p><ul data-chips></ul><textarea name="text"></textarea><div class="bar"><span data-compose-hint></span><label data-attach hidden><input type="file" data-pick /></label><button class="btn" type="button" data-stop hidden>Stop</button><button class="btn" type="button" data-steer hidden>Steer</button><button class="btn" type="submit">Send</button></div></form></div>`;
      const how = { value: "started" };
      const cancel = { status: 200 };
      const page = { html: "" };
      const sent: string[] = [];
      const urls: string[] = [];
      const copied: string[] = [];
      const bodies: { files?: string[] }[] = [];
      const fetchStub = async (u: string, init: { body: string; method?: string }) => {
        urls.push(u);
        if (u.startsWith("?pane=")) return { ok: true, text: async () => page.html };
        if (u.endsWith("/files")) return { ok: true, json: async () => ({ id: "f1", name: "shot.png" }) };
        if (init.method === "DELETE") return { ok: true, json: async () => ({}) };
        if (u.includes("/queue/")) return { ok: cancel.status === 200, status: cancel.status, json: async () => ({}) };
        const body = JSON.parse(init.body);
        sent.push(body.text);
        bodies.push(body);
        return { ok: true, json: async () => ({ how: how.value, queued: "q1" }) };
      };
      const local = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: (k: string) => { delete store[k]; } };
      const nav = { clipboard: { writeText: async (t: string) => { copied.push(t); } } };
      class ES { on: Record<string, (e: { data: string }) => void> = {}; constructor() { sources.push(this); } addEventListener(n: string, f: (e: { data: string }) => void) { this.on[n] = f; } close() {} }
      doc.getElementById("end").scrollIntoView = () => {};
      new Function("document", "window", "EventSource", "fetch", "localStorage", "navigator", talkJs)(doc, window, ES, fetchStub, local, nav);
      const box = doc.querySelector("textarea");
      const key = (init: object) => box.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }));
      const emit = (id: string, html: string) => sources.at(-1)!.on["turn"]!({ data: JSON.stringify({ id, html }) });
      return { how, cancel, page, emit, bodies, sources, urls, window, doc, box, sent, copied, store, key, status: doc.querySelector(".talk-status") };
    };
    const tick = () => new Promise((r) => setTimeout(r, 5));

    test("when a turn ends the preview frame is loaded again (a push has deployed)", async () => {
      const t = await boot();
      const loads: string[] = [];
      const frame = t.doc.createElement("div");
      frame.setAttribute("data-frame", "");
      Object.defineProperty(frame, "src", { get: () => "https://x.example/", set: (v: string) => loads.push(v) });
      t.doc.body.appendChild(frame);
      t.sources.at(-1)!.on["running"]!({ data: "{}" });
      expect(loads).toEqual([]);
      t.sources.at(-1)!.on["done"]!({ data: "{}" });
      expect(loads).toEqual(["https://x.example/"]);
    });

    test("a pane tab swaps the pane in place: no reload, the stream and the composer's words kept", async () => {
      const t = await boot();
      const shell = t.doc.createElement("div");
      shell.setAttribute("data-shell", "");
      shell.dataset.pane = "chat";
      shell.innerHTML = `<nav class="seg talk-tabs"><a href="?pane=chat" aria-current="page">Chat</a><a href="?pane=preview">Preview</a></nav><aside class="talk-pane"><nav class="tabs"><a href="?pane=preview" aria-current="page">Preview</a><a href="?pane=code">Code</a></nav><p>old</p></aside>`;
      t.doc.body.appendChild(shell);
      t.box.value = "half typed";
      const source = t.sources.at(-1);
      const click = (a: any) => a.dispatchEvent(new t.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      click(shell.querySelectorAll(".talk-tabs a")[1]);
      expect(shell.dataset.pane).toBe("preview");
      expect(shell.querySelectorAll(".talk-tabs a")[1].getAttribute("aria-current")).toBe("page");
      t.page.html = `<html><body><div data-shell><aside class="talk-pane"><nav class="tabs"><a href="?pane=code" aria-current="page">Code</a></nav><p>new files</p></aside></div></body></html>`;
      click(shell.querySelector(".talk-pane nav a[href='?pane=code']"));
      await tick();
      expect(t.urls.at(-1)).toBe("?pane=code");
      expect(shell.querySelector(".talk-pane").textContent).toContain("new files");
      expect(t.box.value).toBe("half typed");
      expect(t.sources.at(-1)).toBe(source);
    });

    test("a pasted file becomes a chip with Remove, and a sent message carries its id once", async () => {
      const t = await boot();
      const paste = new t.window.Event("paste", { bubbles: true, cancelable: true }) as any;
      paste.clipboardData = { files: [{ name: "shot.png" }] };
      t.box.dispatchEvent(paste);
      await tick();
      const chips = t.doc.querySelector("[data-chips]");
      expect(chips.textContent).toContain("shot.png");
      expect(chips.querySelector("button").textContent).toBe("Remove");
      t.box.value = "see this";
      t.box.dispatchEvent(new t.window.Event("input", { bubbles: true }));
      t.doc.querySelector("form").requestSubmit();
      await tick();
      expect(t.bodies.at(-1)!.files).toEqual(["f1"]);
      expect(chips.children.length).toBe(0);
      // A removed chip is not sent.
      t.box.dispatchEvent(paste);
      await tick();
      chips.querySelector("button").click();
      await tick();
      expect(chips.children.length).toBe(0);
      t.box.value = "again";
      t.doc.querySelector("form").requestSubmit();
      await tick();
      expect(t.bodies.at(-1)!.files).toEqual([]);
    });

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
      expect(t.doc.querySelector("[data-compose-hint]").textContent).toContain("Enter sends");
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

    test("a turn that arrives again is not drawn twice or replaced, so what is above it keeps its place", async () => {
      const t = await boot();
      const first = t.doc.getElementById("t-1");
      const copy = first.querySelector("pre [data-copy]");
      t.emit("2", '<li class="talk-turn" id="t-2"><div class="talk-body"><pre><code>x</code></pre></div><p class="talk-meta">Forge</p></li>');
      const second = t.doc.getElementById("t-2");
      t.emit("2", '<li class="talk-turn" id="t-2"><div class="talk-body"><p>changed</p></div></li>');
      expect(t.doc.querySelectorAll("#t-2").length).toBe(1);
      expect(t.doc.getElementById("t-2")).toBe(second);
      expect(t.doc.getElementById("t-1")).toBe(first);
      expect(first.querySelector("pre [data-copy]")).toBe(copy);
      expect(t.doc.querySelectorAll("#t-2 pre [data-copy]").length).toBe(1);
    });

    test("a turn arriving while scrolled up does not scroll the page", async () => {
      const t = await boot();
      let scrolled = 0;
      t.doc.getElementById("end").scrollIntoView = () => { scrolled++; };
      Object.defineProperty(t.window, "innerHeight", { value: 800, configurable: true });
      Object.defineProperty(t.window, "scrollY", { value: 0, configurable: true });
      Object.defineProperty(t.doc.documentElement, "scrollHeight", { value: 5000, configurable: true });
      t.window.dispatchEvent(new t.window.Event("scroll"));
      t.emit("2", '<li class="talk-turn" id="t-2"><div class="talk-body"><pre><code>x</code></pre></div></li>');
      expect(scrolled).toBe(0);
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

describe("cost and context (#8822)", () => {
  test("a run's stored usage gives the turn's cost under the reply and the context share in the header", async () => {
    const erin = await createUser(app.db, { origin: "seed", trusted: true, username: "erin", email: "erin@forge.local", password: "a-good-passphrase" });
    if (!erin.ok) throw new Error(erin.error);
    promote(app.db, erin.value);
    const conversation = openConversation(app.db, erin.value.id);
    const before = await (await get("/talk", erin.value)).text();
    expect(before).not.toContain("Context ");
    say(erin.value, "person", "hello");
    const reply = say(erin.value, "agent", "two");
    if (!reply.ok) throw new Error(reply.error);
    const at = new Date(Date.now() - 1000).toISOString();
    app.db
      .query("INSERT INTO conversation_run (id, conversation_id, user_id, prompt, state, cost_usd, tokens_in, tokens_out, context_tokens, context_window, started_at, finished_at) VALUES ('r1',?1,?2,'hello','ok',?3,?4,?5,?6,200000,?7,?8)")
      .run(conversation.id, erin.value.id, 0.1234, 170030, 14, 170020, at, new Date(Date.now() + 1000).toISOString());
    const html = await (await get("/talk", erin.value)).text();
    expect(html).toContain("$0.12 this turn");
    expect(html).toContain("Context 85% full (170k of 200k tokens)");
    expect(html).toContain("A new conversation answers faster");
    // A longer window is read from the run, not assumed.
    app.db.query("UPDATE conversation_run SET context_window = 1000000").run();
    expect(await (await get("/talk", erin.value)).text()).toContain("Context 17% full (170k of 1M tokens)");
    app.db.query("UPDATE conversation_run SET context_window = 200000").run();
    // The stream's end carries both, so a reply that streamed in gets them without a reload.
    const done = (await frames("/talk/stream?after=", erin.value)).find((f) => f.event === "done");
    const sent = JSON.parse(done?.data ?? "{}");
    expect(sent.costs[0].html).toContain("$0.12 this turn");
    expect(sent.context).toContain("Context 85% full");
    // Under 80 %: no suggestion.
    app.db.query("UPDATE conversation_run SET context_tokens = 40000").run();
    const calm = await (await get("/talk", erin.value)).text();
    expect(calm).toContain("Context 20% full");
    expect(calm).not.toContain("A new conversation answers faster");
  });
});

describe("?about= names the subject", () => {
  const subject = (page: string) => /<p class="talk-about[^>]*>[^<]*<\/p>/.exec(page)?.[0];
  test("parseAbout reads owner/repo and owner/repo#N, and nothing else", () => {
    expect(parseAbout("a/b")).toEqual({ owner: "a", repo: "b" });
    expect(parseAbout("a/b#12")).toEqual({ owner: "a", repo: "b", number: 12 });
    for (const bad of ["../x", "a/b#x", "a/b#0", "a/b/c", "", "x".repeat(300), "a/b#1 "]) expect(parseAbout(bad)).toBeNull();
    expect(parseAbout(null)).toBeNull();
  });

  test("a readable issue shows its title, escaped; a repository shows its name", async () => {
    const made = await createRepo(app, alice, { name: "about-pub", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const issue = openIssue(app, alice, made.value, { title: "Fix <b>this</b>", body: "x" });
    if (!issue.ok) throw new Error(String(issue.error));
    const page = await (await get(`/talk?about=${encodeURIComponent(`alice/about-pub#${issue.value.number}`)}`, bob)).text();
    expect(subject(page)).toContain(`About alice/about-pub#${issue.value.number}: Fix &lt;b&gt;this&lt;/b&gt;`);
    expect(page).not.toContain("Fix <b>this</b>");
    expect(subject(await (await get("/talk?about=alice/about-pub", bob)).text())).toContain("About alice/about-pub<");
  });

  test("a private repository names nothing for another person, and looks like one that does not exist", async () => {
    const made = await createRepo(app, alice, { name: "about-priv", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    const issue = openIssue(app, alice, made.value, { title: "Secret title", body: "x" });
    if (!issue.ok) throw new Error(String(issue.error));
    const q = (v: string) => get(`/talk?about=${encodeURIComponent(v)}`, bob).then((r) => r.text());
    const hidden = await q(`alice/about-priv#${issue.value.number}`);
    expect(hidden).not.toContain("Secret title");
    expect(subject(hidden)).toBeUndefined();
    expect(hidden).toBe(await q("alice/no-such-repo#1"));
    expect(await q("alice/about-priv")).toBe(await q("alice/no-such-repo"));
    // Signed out the page sends to sign-in, which only echoes the asked URL: no repository is looked up.
    const out = await get("/talk?about=alice/about-priv");
    expect(out.status).toBe(303);
    expect(out.headers.get("location")).toBe("/signin?next=%2Ftalk%3Fabout%3Dalice%2Fabout-priv");
    expect(await out.text()).not.toContain("Secret title");
    expect(await (await get(`/talk?about=${encodeURIComponent(`alice/about-priv#${issue.value.number}`)}`, alice)).text()).toContain("Secret title");
    // The core lookup both doors share: the owner reads it, another person and nobody do not.
    const ref = `alice/about-priv#${issue.value.number}`;
    expect(aboutLine(app.db, ref, alice)).toBe(`About ${ref}: Secret title`);
    expect(aboutLine(app.db, ref, bob)).toBeNull();
    expect(aboutLine(app.db, ref, undefined)).toBeNull();
    expect(aboutLine(app.db, "alice/about-priv", undefined)).toBeNull();
    expect(aboutLine(app.db, "../x", alice)).toBeNull();
  });

  test("a malformed value is ignored: the page equals plain /talk", async () => {
    const plain = await (await get("/talk", bob)).text();
    for (const bad of ["../x", "a/b#x", "x".repeat(300)]) {
      const res = await get(`/talk?about=${encodeURIComponent(bad)}`, bob);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(plain);
    }
  });

  test("a pull of a private repository names nothing for the person who cannot read it", async () => {
    const made = await createRepo(app, alice, { name: "about-priv-pull", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    const issue = openIssue(app, alice, made.value, { title: "Secret pull", body: "x" });
    if (!issue.ok) throw new Error(String(issue.error));
    app.db.run("UPDATE issue SET kind = 'pull' WHERE id = ?", [issue.value.id]);
    const ref = `alice/about-priv-pull#${issue.value.number}`;
    const seen = await (await get(`/talk?about=${encodeURIComponent(ref)}`, bob)).text();
    expect(seen).not.toContain("Secret pull");
    expect(subject(seen)).toBeUndefined();
    expect(seen).toBe(await (await get(`/talk?about=${encodeURIComponent("alice/none#1")}`, bob)).text());
    expect(subject(await (await get(`/talk?about=${encodeURIComponent(ref)}`, alice)).text())).toContain("Secret pull");
  });

  test("the terminal prints the same gated line: `talk --about <ref>`", () => {
    const run = (user: User | undefined, words: string) => {
      let out = "";
      let code: number | undefined;
      const session = { write: (d: string) => void (out += d), writeStderr: () => {}, exit: (c: number) => void (code = c), onData() {}, onEof() {}, onClose() {} };
      serveTalk(app, session as never, user, words);
      return { out, code };
    };
    const priv = run(alice, "--about alice/about-priv#1");
    expect(priv.code).toBe(0);
    expect(priv.out.startsWith("About alice/about-priv#1: ")).toBe(true);
    expect(run(bob, "--about alice/about-priv#1")).toEqual({ out: "", code: 0 });
    expect(run(undefined, "--about alice/about-priv")).toEqual({ out: "", code: 0 });
    expect(run(bob, "--about alice/about-pub").out).toBe("About alice/about-pub\r\n");
    expect(run(bob, "--about ../x")).toEqual({ out: "", code: 0 });
  });
});

describe("the header's Talk link carries the subject the page rendered", () => {
  const header = (page: string) => /<header class="topbar"[\s\S]*?<\/header>/.exec(page)?.[0] ?? "";
  const talkLinks = (page: string) => [...header(page).matchAll(/href="(\/talk[^"]*)"/g)].map((m) => m[1]);

  test("an issue page and a repository page link /talk?about=…", async () => {
    const made = await createRepo(app, alice, { name: "hdr-pub", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const issue = openIssue(app, alice, made.value, { title: "Hello", body: "x" });
    if (!issue.ok) throw new Error(String(issue.error));
    const n = issue.value.number;
    const links = talkLinks(await (await get(`/alice/hdr-pub/issues/${n}`, bob)).text());
    expect(links).toContain(`/talk?about=alice/hdr-pub%23${n}`);
    expect(links.length).toBeGreaterThanOrEqual(1);
    expect(new Set(links).size).toBe(1);
    expect(talkLinks(await (await get("/alice/hdr-pub", bob)).text())).toContain("/talk?about=alice/hdr-pub");
    expect(talkLinks(await (await get("/explore", bob)).text())).toEqual(["/talk", "/talk"]);
  });

  test("a pull page links /talk?about=owner/repo%23N", async () => {
    const made = await createRepo(app, alice, { name: "hdr-pull", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    for (const [branch, file] of [[undefined, "a.txt"], ["topic", "t.txt"]] as const) {
      const done = await commitToBranch(app, alice, made.value, {
        ...(branch === undefined ? {} : { branch }),
        message: "change",
        files: [{ path: file, content: "x" }],
      });
      if (!done.ok) throw new Error(JSON.stringify(done.error));
    }
    const pull = await openPull(app, alice, made.value, { title: "P", body: "", baseBranch: "main", headBranch: "topic" });
    if (!pull.ok) throw new Error(JSON.stringify(pull.error));
    const res = await get(`/alice/hdr-pull/pulls/${pull.value.number}`, bob);
    expect(res.status).toBe(200);
    expect(talkLinks(await res.text())).toContain(`/talk?about=alice/hdr-pull%23${pull.value.number}`);
  });

  test("a 404 under a private and under a missing repository render the same header", async () => {
    const made = await createRepo(app, alice, { name: "hdr-priv", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    const a = await get("/alice/hdr-priv/issues/1", bob);
    const b = await get("/alice/hdr-nowhere/issues/1", bob);
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    // The rest of the chrome echoes the asked path (the "new issue" link), so compare the Talk entries.
    const [ta, tb] = [talkLinks(await a.text()), talkLinks(await b.text())];
    expect(ta).toEqual(tb);
    expect(ta).toEqual(["/talk", "/talk"]);
  });
});

describe("the first message carries ?about= as fenced context (#10496)", () => {
  const input = () => readFileSync(join(dir, "first.json"), "utf8");
  const send = async (text: string, about: string | null, conversationId?: string, sender: User = alice) => {
    rmSync(join(dir, "first.json"), { force: true });
    const said = talkTo(app, sender, text, [], "queue", conversationId, about);
    if (!said.ok) throw new Error(said.error);
    await said.value.done;
  };
  const fresh = (u: User) => {
    const made = createConversation(app.db, u.id);
    if (!made.ok) throw new Error("conversation");
    return made.value.id;
  };

  beforeAll(() => {
    const bin = join(dir, "claude");
    writeFileSync(
      bin,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
IFS= read -r first
printf '%s' "$first" > "${dir}/first.json"
echo '{"type":"result","subtype":"success","is_error":false,"result":"Heard.","total_cost_usd":0.01,"num_turns":1,"session_id":"s1","terminal_reason":"completed","usage":{"input_tokens":1,"output_tokens":1}}'
`,
    );
    chmodSync(bin, 0o755);
    configureConversation(app, { binary: bin, localUrl: servers.url, budgetUsd: 1, timeoutMs: 30_000, signal: new AbortController().signal });
  });

  test("a readable issue's kind, name, title and body reach the agent fenced, on the first message only", async () => {
    const made = await createRepo(app, alice, { name: "ctx-pub", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const issue = openIssue(app, alice, made.value, { title: "Crash on start", body: "Steps to reproduce" });
    if (!issue.ok) throw new Error(String(issue.error));
    const about = `alice/ctx-pub#${issue.value.number}`;
    const c = fresh(alice);
    await send("what is wrong?", about, c);
    const first = input();
    expect(first).toMatch(/\[\[data ([0-9a-f]+)\]\]/);
    expect(first).toContain("kind: issue");
    expect(first).toContain(`name: ${about}`);
    expect(first).toContain("title: Crash on start");
    expect(first).toContain("body: Steps to reproduce");
    expect(first).toContain("what is wrong?");
    // The stored turn is the person's words alone.
    const turns = listTurns(app.db, alice.id, c);
    if (!turns.ok) throw new Error("turns");
    expect(turns.value.find((t) => t.role === "person")?.text).toBe("what is wrong?");
    await send("and then?", about, c);
    expect(input()).not.toContain("Crash on start");
    expect(input()).toContain("and then?");
  });

  test("a forged about naming a private repository the sender cannot read adds nothing", async () => {
    const made = await createRepo(app, alice, { name: "ctx-priv", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    const issue = openIssue(app, alice, made.value, { title: "Hidden plans", body: "Hidden body" });
    if (!issue.ok) throw new Error(String(issue.error));
    const forged = `alice/ctx-priv#${issue.value.number}`;
    // Admins read everything, so the end-to-end send uses a name that resolves to nothing for its sender;
    // the private case is held at the lookup every send goes through, for a sender who is not the owner.
    expect(aboutContext(app.db, forged, alice)).toContain("Hidden plans");
    const carol = await createUser(app.db, { origin: "seed", trusted: true, username: "ctxreader", email: "ctxreader@forge.local", password: "a-good-passphrase" });
    if (!carol.ok) throw new Error(carol.error);
    for (const who of [carol.value, undefined]) {
      expect(aboutContext(app.db, forged, who)).toBe("");
      expect(aboutContext(app.db, "alice/ctx-priv", who)).toBe("");
    }
    await send("hello", "bob/no-such-repo#1", fresh(alice));
    expect(input()).toContain("hello");
    expect(input()).not.toContain("[[data");
    // End to end: a sender with no grant names the private issue and the agent hears only the words.
    const plan = addSubscription(app.db, dir, { name: "ctx-plan", token: "sk-ant-api-test-token" });
    if (!plan.ok) throw new Error(plan.error);
    setGrants(app.db, carol.value.id, "", [plan.value.id]);
    await send("peek", forged, fresh(carol.value), carol.value);
    expect(input()).toContain("peek");
    expect(input()).not.toContain("[[data");
    expect(input()).not.toContain("Hidden plans");
  });

  test("the terminal's `talk --about` sends the same fenced context", async () => {
    const made = await createRepo(app, alice, { name: "ctx-tty", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const issue = openIssue(app, alice, made.value, { title: "Tty subject", body: "Tty body" });
    if (!issue.ok) throw new Error(String(issue.error));
    rmSync(join(dir, "first.json"), { force: true });
    const session = { write() {}, writeStderr() {}, exit() {}, onData() {}, onEof() {}, onClose() {} };
    fresh(alice); // the latest conversation is the one the terminal speaks in
    serveTalk(app, session as never, alice, `--about alice/ctx-tty#${issue.value.number} why?`);
    for (let i = 0; i < 100 && !existsSync(join(dir, "first.json")); i++) await Bun.sleep(50);
    expect(input()).toContain("title: Tty subject");
    expect(input()).toContain("why?");
  });
});

describe("the header's Talk button counts confirms waiting", () => {
  const talk = async (u?: User) => /<a class="btn btn-icon talk-btn"[^>]*>.*?<\/a>/s.exec(await (await get("/", u)).text())?.[0] ?? "";

  test("a waiting confirm counts for its person only, and a confirm answered clears it", async () => {
    const fay = (await createUser(app.db, { origin: "seed", trusted: true, username: "fay", email: "fay@forge.local", password: "a-good-passphrase" }) as { value: User }).value;
    expect(await talk(fay)).not.toContain("talk-count");
    expect(await talk(fay)).toContain('aria-label="Talk to the forge"');
    const id = hold(app.db, "conversation:talk", fay.id, "mint_invite", {})!;
    hold(app.db, "conversation:talk", fay.id, "mint_invite", {});
    const mine = await talk(fay);
    expect(mine).toContain('aria-label="Talk to the forge, 2 waiting"');
    expect(mine).toContain('<span class="talk-count" aria-hidden="true">2</span>');
    expect(await talk(bob)).not.toContain("2 waiting");
    expect(sayNo({ app }, fay, id).ok).toBe(true);
    expect(await talk(fay)).toContain("Talk to the forge, 1 waiting");
    expect(await (await get("/")).text()).not.toContain("talk-count");
  });
  test("a confirm said yes to clears it, and the box says it was done", async () => {
    const gil = (await createUser(app.db, { origin: "seed", trusted: true, username: "gil", email: "gil@forge.local", password: "a-good-passphrase" }) as { value: User }).value;
    promote(app.db, gil);
    const made = await createRepo(app, gil, { name: "yes-count" });
    if (!made.ok) throw new Error(String(made.error));
    const issue = openIssue(app, gil, made.value, { title: "close me", body: "x" });
    if (!issue.ok) throw new Error(JSON.stringify(issue.error));
    const id = hold(app.db, "conversation:talk", gil.id, "close", { repo: "gil/yes-count", number: issue.value.number })!;
    expect(await talk(gil)).toContain("Talk to the forge, 1 waiting");
    const yes = await sayYes({ app } as never, gil, id);
    expect(yes.ok && yes.done).toBe(true);
    const after = await talk(gil);
    expect(after).not.toContain("talk-count");
    expect(after).toContain('aria-label="Talk to the forge"');
  });

  test("a confirm past its time does not count, swept or not", async () => {
    const hal = (await createUser(app.db, { origin: "seed", trusted: true, username: "hal", email: "hal@forge.local", password: "a-good-passphrase" }) as { value: User }).value;
    hold(app.db, "conversation:talk", hal.id, "mint_invite", {}, Date.now() - HELD_TTL_MS - 1000);
    const left = app.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM conversation_held WHERE user_id = ?1 AND answered_at IS NULL").get(hal.id)!.n;
    expect(left).toBe(1); // still unswept: the count's own filter is what hides it
    expect(await talk(hal)).not.toContain("talk-count");
    hold(app.db, "conversation:talk", hal.id, "mint_invite", {});
    expect(await talk(hal)).toContain("Talk to the forge, 1 waiting");
  });

  test("more than nine waiting shows 9+, and the label says the exact number", async () => {
    const ida = (await createUser(app.db, { origin: "seed", trusted: true, username: "ida", email: "ida@forge.local", password: "a-good-passphrase" }) as { value: User }).value;
    for (let i = 0; i < 9; i++) hold(app.db, "conversation:talk", ida.id, "mint_invite", {});
    expect(await talk(ida)).toContain('<span class="talk-count" aria-hidden="true">9</span>');
    hold(app.db, "conversation:talk", ida.id, "mint_invite", {});
    hold(app.db, "conversation:talk", ida.id, "mint_invite", {});
    const many = await talk(ida);
    expect(many).toContain('<span class="talk-count" aria-hidden="true">9+</span>');
    expect(many).toContain('aria-label="Talk to the forge, 11 waiting"');
  });
});
