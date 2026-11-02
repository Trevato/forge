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
