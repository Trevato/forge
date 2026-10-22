/**
 * The forge button as a feedback door (#4758): a visitor's note becomes an
 * issue labelled `from-app` with its context, is limited and filtered, shows
 * a status that follows the issue, and the owner can hide or ban.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { toolbarJs } from "../src/apps/toolbar.ts";
import { filtered, moderateNote, noteClock, PER_APP_DAY, PER_SENDER, PER_SOURCE, saysFromApp } from "../src/actions/app_notes.ts";
import { feedback, REQUEST_MAX } from "../src/apps/feedback.ts";
import { getAppBySlug } from "../src/core/apps.ts";
import { getNote } from "../src/core/app_notes.ts";
import { grantedCookie } from "./helpers/identity.ts";
import { getIssue, labelsFor, setIssueState } from "../src/core/issues.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const DOMAIN = "apps.test";

describe("the forge button takes notes from anyone", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let alice: User;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-app-feedback-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    servers = await serve(app);
    runtime = new AppsRuntime(app, {
      domain: DOMAIN,
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 1,
    });
    await runtime.start();
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    for (const [name, visibility] of [
      ["notes", "public"],
      ["diary", "private"],
    ] as const) {
      const made = await newApp(app, a.value, { name, description: "Words", visibility });
      if (!made.ok) throw new Error(String(made.error));
    }
  }, 120_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const host = (slug: string) => `${slug}.${DOMAIN}:${servers.port}`;
  const at = (slug: string, path: string, init: RequestInit = {}, cookie = "", source = "") =>
    fetch(`${servers.url}${path}`, {
      ...init,
      headers: {
        host: host(slug),
        ...(init.method === "POST" ? { origin: `http://${host(slug)}`, "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
        ...(source ? { "x-forwarded-for": source } : {}),
        ...(init.headers as Record<string, string>),
      },
      redirect: "manual",
    });
  const post = (text: string, cookie = "", source = "", slug = "notes") =>
    at(slug, "/__forge/note", { method: "POST", body: JSON.stringify({ text, page: `http://${host(slug)}/lists?x=1`, viewport: "390x844" }) }, cookie, source);
  const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  test("a visitor's note files a from-app issue with page, viewport and time", async () => {
    const res = await post("The save button is hidden on my phone", "", "10.0.0.1");
    expect(res.status).toBe(201);
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
    const j = (await res.json()) as { note: { status: { state: string; label: string }; url: string }; name: string };
    expect(j.name).toMatch(/^visitor-[0-9a-f]{6}$/);
    expect(j.note.status.state).toBe("waiting");
    const repo = getRepo(app.db, "alice", "notes")!;
    const issue = getIssue(app.db, repo.id, Number(j.note.url.split("/").pop()))!;
    expect(issue.title).toBe("From the app: The save button is hidden on my phone");
    expect(saysFromApp(issue.title)).toBe(true);
    // The page is code, not a link.
    expect(issue.body).toMatch(/- Page: `http:\/\/notes\.apps\.test[^`]*\/lists`/);
    expect(labelsFor(app.db, issue.id).map((l) => l.name)).toEqual(["from-app"]);
    expect(issue.body).toContain("/lists");
    expect(issue.body).not.toContain("x=1");
    expect(issue.body).toContain("- Viewport: 390x844");
    expect(issue.body).toMatch(/- Time: \d{4}-\d\d-\d\dT/);
    expect(issue.body).toContain(j.name);
    expect(j.note.url).toBe(`${servers.url}/alice/notes/issues/${issue.number}`);
  });

  test("the sender sees their notes, and the status follows the issue", async () => {
    const first = await post("Add dark mode", "", "10.0.0.2");
    const cookie = cookieOf(first);
    const number = Number(((await first.json()) as { note: { url: string } }).note.url.split("/").pop());
    const list = async () =>
      ((await (await at("notes", "/__forge/notes", {}, cookie)).json()) as { notes: { text: string; status: { state: string; label: string } }[] }).notes;
    expect((await list())[0]!.status.state).toBe("waiting");
    const repo = getRepo(app.db, "alice", "notes")!;
    const issue = getIssue(app.db, repo.id, number)!;
    setIssueState(app.db, issue.id, "closed");
    const after = await list();
    expect(after[0]!.text).toBe("Add dark mode");
    expect(after[0]!.status.state).toBe("shipped");
    expect(after[0]!.status.label).toMatch(/^Shipped on \d{4}-/);
    // Someone else sees none of it.
    const other = (await (await at("notes", "/__forge/notes", {}, "forge_visitor=" + "a".repeat(32))).json()) as { notes: unknown[] };
    expect(other.notes).toEqual([]);
  });

  test("only a finished note reads as shipped; the others say what they are", async () => {
    const repo = getRepo(app.db, "alice", "notes")!;
    for (const [reason, label] of [["dropped", /^Closed without a change/], ["parked", /^Set aside/], ["split", /^Split into/], ["done", /^Shipped on/]] as const) {
      const first = await post(`reason ${reason}`, "", `10.6.0.${reason.length}`);
      const cookie = cookieOf(first);
      const n = Number(((await first.json()) as { note: { url: string } }).note.url.split("/").pop());
      setIssueState(app.db, getIssue(app.db, repo.id, n)!.id, "closed", reason);
      const [note] = ((await (await at("notes", "/__forge/notes", {}, cookie)).json()) as { notes: { status: { state: string; label: string } }[] }).notes;
      expect(note!.status.label).toMatch(label);
      expect(note!.status.state === "shipped").toBe(reason === "done");
    }
  });

  test("the app's daily bound refuses a note and files nothing for it", async () => {
    const made = await newApp(app, alice, { name: "ledger", description: "Words", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const repo = getRepo(app.db, "alice", "ledger")!;
    const issues = () => app.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM issue WHERE repo_id = ?1").get(repo.id)!.n;
    const base = issues();
    // The clock moves three minutes a note, so the minute and hour bounds never bind: only the day's.
    let now = Date.now() - 2 * 86_400_000;
    noteClock.now = () => now;
    try {
      const cookie = cookieOf(await post("first", "", "", "ledger"));
      for (let i = 1; i < PER_APP_DAY; i++) {
        now += 180_000;
        expect((await post(`note ${i}`, cookie, "", "ledger")).status).toBe(201);
      }
      expect(issues()).toBe(base + PER_APP_DAY);
      now += 180_000;
      const refused = await post("one too many", cookie, "", "ledger");
      expect(refused.status).toBe(429);
      // Not the hour's wait: the day's.
      expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(3600);
      expect(issues()).toBe(base + PER_APP_DAY);
    } finally {
      noteClock.now = () => Date.now();
    }
  });

  test("a sealed pull's preview takes no note from a visitor, and one from a granted person", async () => {
    const repo = getRepo(app.db, "alice", "notes")!;
    app.db
      .query(
        `INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, sealed)
         VALUES ('sealed-note', ?1, 98, 'pull', 't', '', ?2, 'open', 1)`,
      )
      .run(repo.id, alice.id);
    app.db
      .query("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES ('sealed-note', 'main', 'x', 'a', 'b')")
      .run();
    const issues = () => app.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM issue WHERE repo_id = ?1").get(repo.id)!.n;
    const before = issues();
    const stranger = await post("hello", "", "", "notes--98");
    expect(stranger.status).toBe(404);
    expect(issues()).toBe(before);
    expect((await at("notes--98", "/__forge/notes")).status).toBe(404);
    const owner = await grantedCookie(app, servers.url, alice, getAppBySlug(app.db, "notes")!, "pull-98");
    expect((await post("from a person", owner, "", "notes--98")).status).toBe(201);
    expect(issues()).toBe(before + 1);
    // The same app's production stays open to visitors.
    expect((await post("still open", "", "", "notes")).status).toBe(201);
  });

  test("the word filter and the rate limit apply", async () => {
    const rude = await post("this is sh1t", "", "10.0.0.3");
    expect(rude.status).toBe(422);
    expect(filtered("a perfectly fine idea")).toBe(false);
    const first = await post("one", "", "10.0.0.4");
    const cookie = cookieOf(first);
    for (let i = 1; i < PER_SENDER; i++) expect((await post(`n${i}`, cookie, `10.1.0.${i}`)).status).toBe(201);
    const limited = await post("one too many", cookie, "10.1.0.99");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  test("only this origin may post, and a private app takes nothing from strangers", async () => {
    const cross = await at("notes", "/__forge/note", {
      method: "POST",
      headers: { origin: "http://evil.example" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(cross.status).toBe(403);
    expect((await post("hello", "", "10.0.0.5", "diary")).status).toBe(404);
    expect((await post("   ", "", "10.0.0.6")).status).toBe(400);
  });

  const moderate = async (who: User, id: string, action: "hide" | "ban") =>
    moderateNote(app, getAppBySlug(app.db, "notes")!, getRepo(app.db, "alice", "notes")!, who, id, action);

  test("/__forge/note/moderate is a 404 on the app host, whatever the method, even with an admin grant", async () => {
    const owner = await grantedCookie(app, servers.url, alice, getAppBySlug(app.db, "notes")!);
    for (const method of ["POST", "GET", "PUT", "DELETE"]) {
      for (const cookie of ["", owner]) {
        const res = await at("notes", "/__forge/note/moderate", { method, body: method === "GET" ? undefined : JSON.stringify({ id: "x", action: "ban" }) }, cookie);
        expect(res.status).toBe(404);
      }
    }
  });

  test("the owner hides a note and bans a sender through the function the forge screen calls", async () => {
    const first = await post("spam spam", "", "10.2.0.1");
    const cookie = cookieOf(first);
    const sent = (await first.json()) as { note: { id: string; url: string } };
    const number = Number(sent.note.url.split("/").pop());
    const repo = getRepo(app.db, "alice", "notes")!;
    expect(getIssue(app.db, repo.id, number)!.state).toBe("open");
    // hide: the issue closes, the note leaves the sender's list, they may still write
    expect((await moderate(alice, sent.note.id, "hide")).ok).toBe(true);
    expect(getIssue(app.db, repo.id, number)!.state).toBe("closed");
    expect(((await (await at("notes", "/__forge/notes", {}, cookie)).json()) as { notes: unknown[] }).notes).toEqual([]);
    expect((await post("still fine", cookie, "10.2.0.1")).status).toBe(201);
    // ban: refused from now on
    expect((await moderate(alice, sent.note.id, "ban")).ok).toBe(true);
    expect((await post("again", cookie, "10.2.0.1")).status).toBe(403);
    expect((await moderate(alice, "nope", "ban")).ok).toBe(false);
    const record = app.db.query<{ app_id: string }, [string]>("SELECT app_id FROM app_note WHERE id = ?1").get(sent.note.id)!;
    expect(getNote(app.db, record.app_id, sent.note.id)!.hidden).toBe(true);
  });

  test("the limits are the source's and the app's, not the cookie's, and a refused note spends none", async () => {
    const source = "10.3.0.1";
    const a = cookieOf(await post("first", "", source));
    for (let i = 1; i < PER_SENDER; i++) expect((await post(`a${i}`, a, source)).status).toBe(201);
    // Refused for the sender; none of these may use up the source's budget.
    for (let i = 0; i < 4; i++) expect((await post("more", a, source)).status).toBe(429);
    // Dropping the cookie is a new sender, but the same source.
    let ok = PER_SENDER;
    for (; ok < PER_SOURCE; ok++) expect((await post(`fresh${ok}`, "", source)).status).toBe(201);
    expect((await post("one more", "", source)).status).toBe(429);
  });

  test("a body is read only up to the cap, whatever it declares", async () => {
    const record = getAppBySlug(app.db, "notes")!;
    let pulled = 0;
    const chunk = new TextEncoder().encode("x".repeat(4096));
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        if (pulled > 1000) c.close();
        else c.enqueue(chunk);
      },
    });
    const request = new Request(`http://${host("notes")}/__forge/note`, {
      method: "POST",
      body,
      duplex: "half",
      headers: { host: host("notes"), origin: `http://${host("notes")}`, "content-length": "10" },
    } as RequestInit);
    const res = await feedback({
      app, forgeUrl: servers.url, request, url: new URL(request.url), record, env: "production",
      sealed: false, viewerId: undefined, secure: false, source: "10.4.0.1",
    });
    expect(res!.status).toBe(400);
    // chunked, no honest length: stopped near the cap, not after 4 MB
    expect(pulled * 4096).toBeLessThan(REQUEST_MAX * 3);
    const big = await at("notes", "/__forge/note", { method: "POST", body: JSON.stringify({ text: "y".repeat(REQUEST_MAX + 10) }) }, "", "10.4.0.2");
    expect(big.status).toBe(400);
  });

  test("the source is the socket's client, not a header the client wrote", async () => {
    const { resolveClient } = await import("../src/http/peer.ts");
    const headers = new Headers({ "x-forwarded-for": "198.51.100.7" });
    // From a peer that is not a trusted edge the header is ignored.
    expect(resolveClient("203.0.113.9", headers, { proxies: [] })).toBe("203.0.113.9");
    expect(await Bun.file(join(import.meta.dir, "../src/apps/feedback.ts")).text()).not.toContain("x-forwarded-for");
    expect(await Bun.file(join(import.meta.dir, "../src/actions/app_notes.ts")).text()).not.toContain("x-forwarded-for");
  });

  test("a private app takes notes from a signed-in reader, as themselves, and from no one else", async () => {
    const reader = await grantedCookie(app, servers.url, alice, getAppBySlug(app.db, "diary")!);
    const res = await post("A note on the diary", reader, "10.5.0.1", "diary");
    expect(res.status).toBe(201);
    expect(((await res.json()) as { name: string }).name).toBe("@alice");
    const repo = getRepo(app.db, "alice", "diary")!;
    const issue = app.db.query<{ body: string }, [string]>("SELECT body FROM issue WHERE repo_id = ?1 ORDER BY number DESC").get(repo.id)!;
    expect(issue.body).toContain("by @alice.");
    expect(issue.body).toContain("Untrusted data");
    const mine = (await (await at("diary", "/__forge/notes", {}, reader)).json()) as { notes: unknown[]; admin: boolean };
    expect(mine.notes.length).toBe(1);
    expect(mine.admin).toBe(true);
    expect((await at("diary", "/__forge/notes")).status).toBe(404);
  });

  test("the panel fits a phone and a desktop, and says no forge words first", () => {
    // 390x844: at most 320px wide within the viewport, and 70% high leaves the top (camera) clear.
    expect(toolbarJs).toContain("max-width:min(320px,calc(100vw - 64px))");
    expect(toolbarJs).toContain("max-height:min(70vh,calc(100vh - 88px))");
    expect(toolbarJs).toContain("Tell the builders");
    expect(toolbarJs).toContain("What is this?");
    expect(toolbarJs).toContain("font:16px");
  });
});
