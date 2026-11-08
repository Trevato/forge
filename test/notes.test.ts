/**
 * Notes (#8696): /notes lists what a person wrote, newest first, saves on
 * POST, and shows each note's live state in one line; the planner splits a
 * dump into several issues and attaches an idea to an issue it touches.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { keepThought } from "../src/actions/thought.ts";
import { noteLine } from "../src/core/note_line.ts";
import { getIssue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { thoughtStream, type PlacedLink, type StreamThought } from "../src/core/thought_stream.ts";
import { createUser, type User } from "../src/core/users.ts";
import { placeThought, splitIdeas, attachTarget } from "../src/crew/triage.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const link = (o: Partial<PlacedLink> = {}): PlacedLink => ({
  action: "opened", repo: "alice/forge", number: 5, readable: true, title: "t", issueState: "open", pulls: [], running: false, ...o,
});
const note = (placed: PlacedLink[], o: Partial<StreamThought> = {}): StreamThought => ({
  id: "n", text: "x", source: "composer", receivedAt: "2026-01-01T00:00:00Z", kind: "work", reply: null, asked: false,
  placedAt: "2026-01-01T00:01:00Z", placed, state: "placed", flagged: false, overruled: null, supersededBy: null, repeats: null, supersedes: [], ...o,
});

describe("note line", () => {
  test("one line per state, with links", () => {
    expect(noteLine(note([], { placedAt: null })).text).toBe("Waiting for the planner");
    expect(noteLine(note([link()])).text).toBe("Planned");
    expect(noteLine(note([link({ running: true })])).text).toBe("Building");
    const review = noteLine(note([link({ pulls: [{ number: 9, state: "open" }] })]));
    expect(review.text).toBe("In review");
    expect(review.links.map((l) => l.href)).toEqual(["/alice/forge/issues/5", "/alice/forge/pulls/9"]);
    const merged = [link({ pulls: [{ number: 9, state: "merged" }] })];
    expect(noteLine(note(merged, { state: "shipped" }), (r, p) => (r === "alice/forge" && p === 9 ? "0.7.9" : undefined)).text).toBe("Shipped in version 0.7.9");
    expect(noteLine(note(merged, { state: "shipped" })).text).toBe("Shipped");
  });
  test("a split dump counts its issues; a vision is kept", () => {
    const l = noteLine(note([link(), link({ number: 6, pulls: [{ number: 9, state: "merged" }] }), link({ number: 7, running: true })]));
    expect(l.text).toBe("3 issues: 1 shipped, 1 building, 1 planned");
    expect(l.phase).toBe("planned");
    expect(noteLine(note([], { reply: "Kept as a note: what should change?" })).phase).toBe("declined");
  });
});

describe("verdicts", () => {
  test("decline, duplicate and snooze say which and why, each with one tap to overrule", () => {
    const declined = noteLine(note([], { reply: "Kept as a note: what should change?" }));
    expect(declined.text).toBe("Declined: Kept as a note: what should change?");
    expect(declined.overrule?.do).toBe("build");
    const dup = noteLine(note([link({ action: "linked", running: true })], { reply: "You asked this on 2026-01-01; #5 is open.", repeats: { id: "e", text: "x", receivedAt: "" } }));
    expect(dup.phase).toBe("duplicate");
    expect(dup.text).toContain("You asked this on 2026-01-01");
    expect(dup.overrule?.do).toBe("build");
    const snoozed = noteLine(note([link(), link({ action: "deferred" })], { reply: "Snoozed: you said it can wait." }));
    expect(snoozed.phase).toBe("snoozed");
    expect(snoozed.overrule?.do).toBe("build");
    expect(noteLine(note([link()])).overrule?.do).toBe("decline");
    expect(noteLine(note([link({ running: true })])).overrule).toBeNull();
    expect(noteLine(note([link()], { overruled: "declined" })).text).toBe("Declined by you");
    expect(noteLine(note([link(), link({ action: "deferred" })], { overruled: "accepted" })).phase).toBe("planned");
  });
});

describe("splitIdeas / attachTarget", () => {
  test("bullets and paragraphs split; one idea stays whole", () => {
    expect(splitIdeas("things:\n- make the search faster\n- add dark mode toggle\n  in settings\n- show build time")).toEqual([
      "make the search faster", "add dark mode toggle\nin settings", "show build time",
    ]);
    expect(splitIdeas("make the search faster please\n\nadd a dark mode toggle")).toHaveLength(2);
    expect(splitIdeas("just one idea about the search box")).toEqual(["just one idea about the search box"]);
  });
  test("attaches only on a close match that is not a reversal", () => {
    const open = [{ number: 4, title: "make the search box visible on tablets" }];
    expect(attachTarget("also make search box visible on tablets please", open)?.number).toBe(4);
    expect(attachTarget("make the search box hidden on tablets", open)).toBeUndefined();
    expect(attachTarget("paint the footer green", open)).toBeUndefined();
  });
});

describe("notes", () => {
  let dir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let repo: Repo;
  const fresh = () => getRepoById(app.db, repo.id)!;
  const cookie = (u: User) => `forge_session=${createSession(app.db, u.id).token}`;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-notes-"));
    app = createApp({ dataDir: dir, port: 0 });
    const mk = async (username: string, first = false) => {
      const u = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first });
      if (!u.ok) throw new Error(String(u.error));
      return u.value;
    };
    alice = await mk("alice", true);
    bob = await mk("bob");
    const r = await createRepo(app, alice, { name: "forge", visibility: "private" });
    if (!r.ok) throw new Error(String(r.error));
    repo = r.value;
    await updateRepoSettings(app, alice, repo, { autonomy: "autonomous", autonomyDirection: "Steer by thought.", autonomyCeilingUsd: 10, autonomySlots: 1, autonomyBy: alice.id });
    servers = await serve(app);
  });
  afterAll(async () => {
    servers.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const post = (u: User | undefined, text: string, origin = servers.url) =>
    fetch(`${servers.url}/notes`, {
      method: "POST", redirect: "manual",
      headers: { origin, ...(u ? { cookie: cookie(u) } : {}) },
      body: new URLSearchParams({ text }),
    });
  const get = (u?: User) => fetch(`${servers.url}/notes`, { redirect: "manual", headers: u ? { cookie: cookie(u) } : {} });

  test("signed out goes to sign in", async () => {
    expect((await get()).status).toBe(303);
    expect((await post(undefined, "hello there")).status).toBe(303);
  });

  test("saves a note, newest first, escaped, private to its author", async () => {
    expect((await post(alice, "first idea about search")).status).toBe(303);
    await Bun.sleep(5);
    expect((await post(alice, "<b>second</b> idea about tablets")).status).toBe(303);
    const html = await (await get(alice)).text();
    expect(html).toContain("Waiting for the planner");
    expect(html).toContain("&lt;b&gt;second&lt;/b&gt;");
    expect(html).not.toContain("<b>second</b>");
    expect(html.indexOf("second")).toBeLessThan(html.indexOf("first idea"));
    expect(html).toContain('enterkeyhint="send"');
    expect(await (await get(bob)).text()).not.toContain("first idea");
  });

  test("refuses empty, oversized and cross-origin writes", async () => {
    const before = thoughtStream(app.db, alice).length;
    expect((await post(alice, "   ")).status).toBe(303);
    expect((await post(alice, "x".repeat(20_001))).status).toBe(303);
    expect((await post(alice, "sneaky", "https://evil.example")).status).toBe(403);
    expect(thoughtStream(app.db, alice).length).toBe(before);
  });

  test("a dump becomes several issues linked back, and the page says so", async () => {
    const kept = keepThought(app, alice, "- build a sparkline for spend per day\n- show the queue depth on the front page\n- export the audit log as csv", "composer");
    if (!kept.ok) throw new Error(kept.error);
    const p = await placeThought(app, fresh(), alice, { id: kept.value.id, text: "- build a sparkline for spend per day\n- show the queue depth on the front page\n- export the audit log as csv" });
    expect(p.placed.filter((x) => x.action === "opened")).toHaveLength(3);
    const issue = getIssue(app.db, repo.id, p.placed[0]!.number)!;
    expect(issue.body).toContain(kept.value.id);
    const html = await (await get(alice)).text();
    expect(html).toContain("3 issues: 3 planned");
    expect(html).toContain(`/alice/forge/issues/${p.placed[0]!.number}`);
  });

  test("an idea that touches an open issue attaches rather than duplicates", async () => {
    const opened = openIssue(app, alice, fresh(), { title: "make the tablet toolbar sticky while scrolling", body: "" });
    if (!opened.ok) throw new Error(String(opened.error));
    const text = "please make the tablet toolbar sticky while scrolling";
    const kept = keepThought(app, alice, text, "composer");
    if (!kept.ok) throw new Error(kept.error);
    const p = await placeThought(app, fresh(), alice, { id: kept.value.id, text });
    expect(p.placed).toEqual([{ action: "amended", repo: "alice/forge", number: opened.value.number }]);
  });

  const overrule = (u: User, id: string, to: string) =>
    fetch(`${servers.url}/notes/${id}/overrule`, { method: "POST", redirect: "manual", headers: { origin: servers.url, cookie: cookie(u) }, body: new URLSearchParams({ do: to }) });
  const rowOf = (id: string) => thoughtStream(app.db, alice).find((n) => n.id === id)!;

  test("a note that can wait is snoozed with its reason, and one tap lets it out", async () => {
    const gate = openIssue(app, alice, fresh(), { title: "Later gate: wait here" });
    if (!gate.ok) throw new Error(String(gate.error));
    const text = "someday add a keyboard shortcut cheatsheet overlay";
    const kept = keepThought(app, alice, text, "composer");
    if (!kept.ok) throw new Error(kept.error);
    const p = await placeThought(app, fresh(), alice, { id: kept.value.id, text });
    expect(p.placed.map((x) => x.action)).toEqual(["opened", "deferred"]);
    const html = await (await get(alice)).text();
    expect(html).toContain("Snoozed: you said it can wait");
    expect(html).toContain("Build it anyway");
    expect((await overrule(bob, kept.value.id, "build")).status).toBe(303);
    expect(rowOf(kept.value.id).overruled).toBeNull();
    expect((await overrule(alice, kept.value.id, "build")).status).toBe(303);
    expect(rowOf(kept.value.id).overruled).toBe("accepted");
    expect(noteLine(rowOf(kept.value.id)).phase).toBe("planned");
  });

  test("a guest and a cross-origin post cannot overrule", async () => {
    const kept = keepThought(app, alice, "alice/forge", "composer");
    if (!kept.ok) throw new Error(kept.error);
    await placeThought(app, fresh(), alice, { id: kept.value.id, text: "alice/forge" });
    const url = `${servers.url}/notes/${kept.value.id}/overrule`;
    const guest = await fetch(url, { method: "POST", redirect: "manual", headers: { origin: servers.url }, body: new URLSearchParams({ do: "build" }) });
    expect(guest.status).not.toBe(200);
    const cross = await fetch(url, { method: "POST", redirect: "manual", headers: { origin: "https://evil.example", cookie: cookie(alice) }, body: new URLSearchParams({ do: "build" }) });
    expect(cross.status).toBe(403);
    expect(rowOf(kept.value.id).overruled).toBeNull();
    expect(rowOf(kept.value.id).placed).toHaveLength(0);
  });

  test("a second build tap, or a build on an accepted note, opens nothing more", async () => {
    const kept = keepThought(app, alice, "alice/forge", "composer");
    if (!kept.ok) throw new Error(kept.error);
    await placeThought(app, fresh(), alice, { id: kept.value.id, text: "alice/forge" });
    await overrule(alice, kept.value.id, "build");
    await overrule(alice, kept.value.id, "build");
    expect(rowOf(kept.value.id).placed).toHaveLength(1);
    const text = "list the stale branches on the repository page";
    const k2 = keepThought(app, alice, text, "composer");
    if (!k2.ok) throw new Error(k2.error);
    await placeThought(app, fresh(), alice, { id: k2.value.id, text });
    const before = rowOf(k2.value.id).placed.length;
    await overrule(alice, k2.value.id, "build");
    expect(rowOf(k2.value.id).placed).toHaveLength(before);
    expect(rowOf(k2.value.id).overruled).toBeNull();
  });

  test("one 'someday' bullet snoozes its own idea only, and 'backlog' is an ordinary word", async () => {
    const gate = openIssue(app, alice, fresh(), { title: "Later gate: wait here" });
    if (!gate.ok) throw new Error(String(gate.error));
    const text = "- surface the backlog totals within the sidebar widget\n- someday add a printable receipt view\n- add an export button to the audit trail";
    const kept = keepThought(app, alice, text, "composer");
    if (!kept.ok) throw new Error(kept.error);
    const p = await placeThought(app, fresh(), alice, { id: kept.value.id, text });
    expect(p.placed.filter((x) => x.action === "opened")).toHaveLength(3);
    const deferred = p.placed.filter((x) => x.action === "deferred");
    expect(deferred).toHaveLength(1);
    const wait = getIssue(app.db, repo.id, deferred[0]!.number)!;
    expect(wait.body).toContain("printable receipt");
  });

  test("a declined note is built after all on one tap", async () => {
    const kept = keepThought(app, alice, "alice/forge", "composer");
    if (!kept.ok) throw new Error(kept.error);
    await placeThought(app, fresh(), alice, { id: kept.value.id, text: "alice/forge" });
    expect(noteLine(rowOf(kept.value.id)).phase).toBe("declined");
    expect((await overrule(alice, kept.value.id, "build")).status).toBe(303);
    const after = rowOf(kept.value.id);
    expect(after.placed.map((x) => x.action)).toEqual(["opened"]);
    expect(noteLine(after).phase).toBe("planned");
  });

  test("an accepted note is declined on one tap: its issue closes", async () => {
    const text = "render the pull list as a compact table";
    const kept = keepThought(app, alice, text, "composer");
    if (!kept.ok) throw new Error(kept.error);
    const p = await placeThought(app, fresh(), alice, { id: kept.value.id, text });
    const number = p.placed[0]!.number;
    expect(noteLine(rowOf(kept.value.id)).overrule?.do).toBe("decline");
    expect((await overrule(alice, kept.value.id, "decline")).status).toBe(303);
    expect(getIssue(app.db, repo.id, number)!.state).toBe("closed");
    expect(noteLine(rowOf(kept.value.id)).text).toBe("Declined by you");
    expect((await overrule(alice, kept.value.id, "nonsense")).status).toBe(303);
  });
});
