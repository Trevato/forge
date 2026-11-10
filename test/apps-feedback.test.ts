/**
 * The forge button as a feedback door (#4758): a visitor's note becomes an
 * issue labelled `from-app` with its context, is limited and filtered, shows
 * a status that follows the issue, and the owner can hide or ban.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { AppsRuntime, type EnvStatus } from "../src/apps/runtime.ts";
import { renderMarkdown } from "../src/web/markdown.ts";
import { toolbarJs } from "../src/apps/toolbar.ts";
import { filtered, moderateNote, noteClock, PER_APP_DAY, PER_SENDER, PER_SOURCE, saysFromApp } from "../src/actions/app_notes.ts";
import { feedback, REQUEST_MAX } from "../src/apps/feedback.ts";
import { getAppBySlug } from "../src/core/apps.ts";
import { getNote, isBanned } from "../src/core/app_notes.ts";
import { grantedCookie } from "./helpers/identity.ts";
import { recordRelease } from "../src/release/record.ts";
import { createIssue, getIssue, labelsFor, setIssueState } from "../src/core/issues.ts";
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
      ["context", "public"],
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
  /** A page load through the proxy; the app behind it is a stub that serves a small page. */
  const page = async (slug: string, cookie: string, headers: Record<string, string> = {}): Promise<{ res: Response; proof: string | undefined }> => {
    const backend = Bun.serve({ port: 0, fetch: () => new Response("<html><body>hi</body></html>", { headers: { "content-type": "text/html" } }) });
    const spy = spyOn(AppsRuntime.prototype, "envStatus").mockImplementation(
      () => ({ env: "production", state: "running", port: backend.port, commitOid: "a".repeat(40) }) as EnvStatus,
    );
    try {
      const res = await at(slug, "/", { headers }, cookie);
      const text = await res.text();
      return { res, proof: /data-proof="([^"]+)"/.exec(text)?.[1] };
    } finally {
      spy.mockRestore();
      backend.stop(true);
    }
  };
  const withProof = (proof: string | undefined, headers: Record<string, string> = {}) => ({ ...headers, ...(proof ? { "x-forge-proof": proof } : {}) });
  const postAs = (slug: string, cookie: string, proof: string | undefined, text = "A note") =>
    at(slug, "/__forge/note", { method: "POST", headers: withProof(proof), body: JSON.stringify({ text, page: `http://${host(slug)}/`, viewport: "390x844" }) }, cookie, `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`);
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

  test("a note's context is stored under a fold: build from the forge, errors scrubbed, capped and escaped", async () => {
    const spy = spyOn(AppsRuntime.prototype, "liveFor").mockImplementation(() => ({ commitOid: "c0ffee1234567890abcdef" }) as never);
    try {
      const send = (extra: Record<string, unknown>, source: string) =>
        at("context", "/__forge/note", { method: "POST", body: JSON.stringify({ text: "It broke", page: `http://${host("context")}/cart?x=1`, viewport: "390x844", ...extra }) }, "", source);
      const bodyOf = async (res: Response) => {
        expect(res.status).toBe(201);
        const j = (await res.json()) as { note: { url: string } };
        return getIssue(app.db, getRepo(app.db, "alice", "context")!.id, Number(j.note.url.split("/").pop()))!.body;
      };
      const hostile = ["<img src=x onerror=alert(1)> `tick`", "x".repeat(900), "GET http://a.test/p?api_key=sekret failed", "t1", "t2", "t3 beyond five", 7, { a: 1 }];
      const body = await bodyOf(await send({ errors: hostile, build: "deadbeef" }, "10.7.0.1"));
      expect(body).toContain("<details><summary>Where this came from</summary>");
      expect(body).toContain("- Build: `c0ffee1234567890abcdef`"); // the forge's, never the client's `build`
      expect(body).not.toContain("deadbeef");
      expect(body).not.toContain("- Path:");
      expect(body).not.toMatch(/sekret|beyond five/);
      const lines = body.split("\n").filter((l) => l.startsWith("- Console error:"));
      expect(lines.length).toBe(5);
      expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(200 + 20);
      expect(lines[0]).not.toContain("`tick`");
      const rendered = String(renderMarkdown(body));
      expect(rendered).not.toContain("<img");
      expect(rendered).toContain("&lt;img");
      // No context at all: the note still goes, the fold only says the build.
      expect(await bodyOf(await send({ errors: "nope" }, "10.7.0.2"))).not.toContain("Console error");
      // An oversized request is refused before any of it is read.
      const big = await send({ errors: ["e".repeat(REQUEST_MAX)] }, "10.7.0.3");
      expect(big.status).toBe(400);
    } finally {
      spy.mockRestore();
    }
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
    const { proof } = await page("notes--98", owner);
    expect((await postAs("notes--98", owner, proof, "from a person")).status).toBe(201);
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

  test("a note's fix says the release it is in, or the date it merged", async () => {
    const made = await newApp(app, alice, { name: "shipping", description: "Words", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const repo = getRepo(app.db, "alice", "shipping")!;
    const land = (n: number, mergedAt: string) => {
      const pr = createIssue(app.db, { repoId: repo.id, authorId: alice.id, title: `fix ${n}`, body: `Closes #${n}`, kind: "pull" });
      if (!pr.ok) throw new Error("pull");
      app.db.query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at) VALUES (?1, 'main', 'fix', 'a', 'b', ?2)`).run(pr.value.id, mergedAt);
      return pr.value.number;
    };
    const label = async (text: string, ip: string, mergedAt: string, released: boolean) => {
      const first = await post(text, "", ip, "shipping");
      const cookie = cookieOf(first);
      const n = Number(((await first.json()) as { note: { url: string } }).note.url.split("/").pop());
      const pull = land(n, mergedAt);
      if (released) recordRelease(app.db, { sha: "c0ffee".repeat(6), repoId: repo.id, pullNumber: pull, ok: true, line: "ok" });
      setIssueState(app.db, getIssue(app.db, repo.id, n)!.id, "closed", "done");
      const [note] = ((await (await at("shipping", "/__forge/notes", {}, cookie)).json()) as { notes: { status: { state: string; label: string } }[] }).notes;
      expect(note!.status.state).toBe("shipped");
      return note!.status.label;
    };
    expect(await label("released fix", "10.7.0.1", "2026-03-04T10:00:00Z", true)).toBe("Shipped in c0ffeec0ffee");
    expect(await label("merged fix", "10.7.0.2", "2026-03-04T10:00:00Z", false)).toBe("Shipped on 2026-03-04");
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

  test("the button shows 'Filed as #N' linked, at once, only to forge-origin links", () => {
    expect(toolbarJs).toContain('"Filed as #" + n.number');
    expect(toolbarJs).toContain("filed(a.j && a.j.note);");
    expect(toolbarJs).toContain("n.repoUrl && link(n.repoUrl");
    // A link is built only after its origin is checked against the forge's.
    expect(toolbarJs).toMatch(/if \(l\.origin !== forgeOrigin\) return null;/);
  });

  test("a private app takes notes from a signed-in reader, as themselves, and from no one else", async () => {
    const reader = await grantedCookie(app, servers.url, alice, getAppBySlug(app.db, "diary")!);
    const first = await page("diary", reader);
    const res = await postAs("diary", reader, first.proof, "A note on the diary");
    expect(res.status).toBe(201);
    const sentJson = (await res.json()) as { name: string; note: { number: number; url: string; repoUrl: string } };
    expect(sentJson.name).toBe("@alice");
    // A reader of the repository is given the number, the issue's link and the repository's (#10560).
    expect(sentJson.note.number).toBeGreaterThan(0);
    expect(sentJson.note.url).toBe(`${servers.url}/alice/diary/issues/${sentJson.note.number}`);
    expect(sentJson.note.repoUrl).toBe(`${servers.url}/alice/diary`);
    const repo = getRepo(app.db, "alice", "diary")!;
    const issue = app.db.query<{ body: string }, [string]>("SELECT body FROM issue WHERE repo_id = ?1 ORDER BY number DESC").get(repo.id)!;
    expect(issue.body).toContain("by @alice.");
    expect(issue.body).toContain("Untrusted data");
    const mine = (await (await at("diary", "/__forge/notes", { headers: withProof(res.headers.get("x-forge-proof")!) }, reader)).json()) as { notes: { number: number; url?: string; repoUrl?: string }[]; admin: boolean };
    expect(mine.notes.length).toBe(1);
    expect(mine.notes[0]).toMatchObject({ number: sentJson.note.number, url: sentJson.note.url, repoUrl: sentJson.note.repoUrl });
    expect(mine.admin).toBe(true);
    expect((await at("diary", "/__forge/notes")).status).toBe(404);
  });

  test("the studio page lists the notes; a writer hides one, bans a sender and unbans them; a stranger sees and can do nothing", async () => {
    // The minute's bounds are spent by the tests before; this one starts a later minute.
    const start = Date.now() + 120_000;
    noteClock.now = () => start;
    const signin = await fetch(`${servers.url}/signin`, {
      method: "POST",
      headers: { origin: servers.url },
      body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
      redirect: "manual",
    });
    const me = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
    const forge = (path: string, init: RequestInit = {}, cookie = me) =>
      fetch(`${servers.url}${path}`, {
        ...init,
        headers: { origin: servers.url, ...(cookie ? { cookie } : {}), ...(init.headers as Record<string, string>) },
        redirect: "manual",
      });
    const form = (body: Record<string, string>, cookie = me) =>
      forge("/alice/notes/app/notes", { method: "POST", body: new URLSearchParams(body) }, cookie);
    const first = await post("studio words one", "", "10.7.0.1");
    const cookie = cookieOf(first);
    const sent = (await first.json()) as { note: { id: string; url: string }; name: string };
    const number = Number(sent.note.url.split("/").pop());
    const repo = getRepo(app.db, "alice", "notes")!;

    const page = await (await forge("/alice/notes")).text();
    expect(page).toContain("studio words one");
    expect(page).toContain(sent.name);
    expect(page).toContain("anonymous");
    expect(page).toContain("/lists");
    expect(page).toContain("Hide");
    expect(page).toContain("Ban sender");
    // a stranger reads no list and the post is refused
    const stranger = await (await forge("/alice/notes", {}, "")).text();
    expect(stranger).not.toContain("Ban sender");
    expect(stranger).not.toContain('id="app-notes"');
    const refused = await form({ id: sent.note.id, action: "hide" }, "");
    expect(refused.status).toBe(303);
    expect(refused.headers.get("location") ?? "").toContain("/signin");
    expect(getIssue(app.db, repo.id, number)!.state).toBe("open");
    // same-origin is checked
    const cross = await forge("/alice/notes/app/notes", { method: "POST", headers: { origin: "http://evil.example" }, body: new URLSearchParams({ id: sent.note.id, action: "hide" }) });
    expect(cross.status).toBe(403);
    expect((await form({ id: sent.note.id, action: "nuke" })).status).toBe(400);

    // hide: the issue closes and the row goes
    expect((await form({ id: sent.note.id, action: "hide" })).status).toBe(303);
    expect(getIssue(app.db, repo.id, number)!.state).toBe("closed");
    expect(await (await forge("/alice/notes")).text()).not.toContain(`value="${sent.note.id}"`);

    // ban: the sender's next note is refused and they are listed once with Unban
    const second = await post("studio words two", cookie, "10.7.0.1");
    expect(second.status).toBe(201);
    const secondId = ((await second.json()) as { note: { id: string } }).note.id;
    expect((await form({ id: secondId, action: "ban" })).status).toBe(303);
    expect((await post("again", cookie, "10.7.0.1")).status).toBe(403);
    const banned = await (await forge("/alice/notes")).text();
    expect(banned).toContain("Banned senders");
    expect(banned.split(`value="${secondId}"`).length - 1).toBe(1);
    // a signed-in reader who is not an admin sees no card and can do nothing
    const bobMade = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
    if (!bobMade.ok) throw new Error(bobMade.error);
    const bobIn = await fetch(`${servers.url}/signin`, {
      method: "POST",
      headers: { origin: servers.url },
      body: new URLSearchParams({ username: "bob", password: "a-good-passphrase" }),
      redirect: "manual",
    });
    const bob = (bobIn.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(bob).not.toBe("");
    const record = getAppBySlug(app.db, "notes")!;
    const bobPage = await (await forge("/alice/notes", {}, bob)).text();
    expect(bobPage).not.toContain('id="app-notes"');
    expect(bobPage).not.toContain("studio words two");
    expect(bobPage).not.toContain(sent.name);
    const bannedBefore = isBanned(app.db, record.id, getNote(app.db, record.id, secondId)!.visitor);
    expect(bannedBefore).toBe(true);
    const third = await post("studio words three", "", "10.7.0.9");
    const thirdNote = ((await third.json()) as { note: { id: string; url: string } }).note;
    const thirdId = thirdNote.id;
    const thirdNumber = Number(thirdNote.url.split("/").pop());
    for (const action of ["hide", "ban", "unban"]) {
      for (const id of [action === "unban" ? secondId : thirdId]) {
        const refused = await form({ id, action }, bob);
        expect(refused.status).toBe(303);
        const flashed = await forge("/alice/notes", {}, `${bob}; ${(refused.headers.get("set-cookie") ?? "").split(";")[0]}`);
        expect(await flashed.text()).toContain("You need admin access to do that.");
      }
    }
    expect(getIssue(app.db, repo.id, thirdNumber)!.state).toBe("open");
    expect(isBanned(app.db, record.id, getNote(app.db, record.id, thirdId)!.visitor)).toBe(false);
    expect(isBanned(app.db, record.id, getNote(app.db, record.id, secondId)!.visitor)).toBe(true);
    // unban
    expect((await form({ id: secondId, action: "unban" })).status).toBe(303);
    expect((await post("back again", cookie, "10.7.0.1")).status).toBe(201);
    expect(await (await forge("/alice/notes")).text()).not.toContain(`value="${secondId}"`);
    // the app host answers 404 for moderation, and for the forge's own path too
    for (const path of ["/__forge/note/moderate", "/app/notes"])
      expect((await at("notes", path, { method: "POST", body: JSON.stringify({ id: secondId, action: "ban" }) }, "")).status).toBe(404);
  });

  test("a note from the app's own origin is a visitor's unless it carries the panel's proof", async () => {
    const record = getAppBySlug(app.db, "notes")!;
    const owner = await grantedCookie(app, servers.url, alice, record);
    const list = async (cookie: string, proof?: string) =>
      (await (await at("notes", "/__forge/notes", { headers: withProof(proof) }, cookie)).json()) as { name: string; admin: boolean };

    // Unproven: the grant cookie alone is a visitor.
    const bare = await postAs("notes", owner, undefined);
    expect(bare.status).toBe(201);
    expect(((await bare.json()) as { name: string }).name).toMatch(/^visitor-/);
    expect(bare.headers.get("x-forge-proof")).toBeNull();
    const seen = await list(owner);
    expect(seen.name).toMatch(/^visitor-/);
    expect(seen.admin).toBe(false);

    // Proven: @alice, the list is theirs, and the answer carries the next token.
    const loaded = await page("notes", owner);
    expect(loaded.proof).toBeTruthy();
    expect(loaded.res.headers.get("cache-control")).toBe("private, no-store");
    const proven = await postAs("notes", owner, loaded.proof);
    expect(((await proven.json()) as { name: string }).name).toBe("@alice");
    const next = proven.headers.get("x-forge-proof")!;
    expect(next).toBeTruthy();
    expect(next).not.toBe(loaded.proof);
    const mine = await list(owner, next);
    expect(mine.name).toBe("@alice");
    expect(mine.admin).toBe(true);

    // Reused: the spent token is a visitor.
    const reused = await postAs("notes", owner, loaded.proof);
    expect(((await reused.json()) as { name: string }).name).toMatch(/^visitor-/);
    expect(reused.headers.get("x-forge-proof")).toBeNull();

    // Another grant's token, and another host's.
    const bob = await createUser(app.db, { origin: "seed", trusted: true, username: "carol", email: "carol@forge.local", password: "a-good-passphrase" });
    if (!bob.ok) throw new Error(bob.error);
    const bobs = await grantedCookie(app, servers.url, bob.value, record);
    const foreignGrant = await page("notes", owner);
    expect((await list(bobs, foreignGrant.proof)).name).toMatch(/^visitor-/);
    const foreignHost = await page("notes", owner);
    const onOther = await at("diary", "/__forge/notes", { headers: withProof(foreignHost.proof) }, await grantedCookie(app, servers.url, alice, getAppBySlug(app.db, "diary")!));
    expect(onOther.status).toBe(404);

    // A same-origin fetch of the page gets no token; a document load and a cross-site frame do.
    expect((await page("notes", owner, { "sec-fetch-dest": "empty", "sec-fetch-site": "same-origin" })).proof).toBeUndefined();
    expect((await page("notes", owner, { "sec-fetch-dest": "iframe", "sec-fetch-site": "same-origin" })).proof).toBeUndefined();
    expect((await page("notes", owner, { "sec-fetch-dest": "document" })).proof).toBeTruthy();
    expect((await page("notes", owner, { "sec-fetch-dest": "iframe", "sec-fetch-site": "cross-site" })).proof).toBeTruthy();
    // A visitor with no grant is given none.
    expect((await page("notes", "")).proof).toBeUndefined();
  });

  test("app code that holds the cookie and a copy of a spent or stale token is refused", async () => {
    const owner = await grantedCookie(app, servers.url, alice, getAppBySlug(app.db, "notes")!);
    const loaded = await page("notes", owner);
    // The panel spends the page's token and gets the next; a hostile script that
    // copied the page's token, or guesses one, acts as a visitor.
    const panel = await postAs("notes", owner, loaded.proof);
    expect(((await panel.json()) as { name: string }).name).toBe("@alice");
    for (const stolen of [loaded.proof, "A".repeat(32), ""]) {
      const res = await postAs("notes", owner, stolen);
      expect(((await res.json()) as { name: string }).name).toMatch(/^visitor-/);
      expect(res.headers.get("x-forge-proof")).toBeNull();
    }
    // The chain's next token is still good for the panel.
    const next = panel.headers.get("x-forge-proof")!;
    const again = await at("notes", "/__forge/notes", { headers: withProof(next) }, owner);
    expect(((await again.json()) as { name: string }).name).toBe("@alice");
  });

  test("a refused note still hands on the next proof, and the next note goes as the person", async () => {
    const owner = await grantedCookie(app, servers.url, alice, getAppBySlug(app.db, "notes")!);
    const loaded = await page("notes", owner);
    let proof = loaded.proof;
    let limited: Response | undefined;
    for (let i = 0; i <= PER_SENDER + 1 && limited === undefined; i++) {
      const res = await postAs("notes", owner, proof, `chain ${i}`);
      proof = res.headers.get("x-forge-proof") ?? undefined;
      expect(proof).toBeTruthy();
      if (res.status === 429) limited = res;
    }
    expect(limited).toBeDefined();
    const bad = await at("notes", "/__forge/note", { method: "POST", headers: withProof(proof), body: "{" }, owner);
    expect(bad.status).toBe(400);
    proof = bad.headers.get("x-forge-proof") ?? undefined;
    expect(proof).toBeTruthy();
    const rude = await at("notes", "/__forge/note", { method: "POST", headers: withProof(proof), body: JSON.stringify({ text: "this is sh1t" }) }, owner);
    expect(rude.status).toBe(422);
    proof = rude.headers.get("x-forge-proof") ?? undefined;
    expect(proof).toBeTruthy();
    const mine = (await (await at("notes", "/__forge/notes", { headers: withProof(proof) }, owner)).json()) as { name: string };
    expect(mine.name).toMatch(/^@/);
  });

  test("a send the network rejected is retried with the same proof and goes as the person", async () => {
    const owner = await grantedCookie(app, servers.url, alice, getAppBySlug(app.db, "notes")!);
    const loaded = await page("notes", owner);
    // The first send never arrives, so the door never sees it; the panel keeps its token.
    const retry = await postAs("notes", owner, loaded.proof, "second try");
    expect(retry.status === 201 || retry.status === 429).toBe(true);
    expect(retry.headers.get("x-forge-proof")).toBeTruthy();
    if (retry.status === 201) expect(((await retry.json()) as { name: string }).name).toMatch(/^@/);
  });

  test("the panel keeps its proof unless an answer brings the next", () => {
    const call = /function call\([\s\S]*?\n  \}\n/.exec(toolbarJs)![0];
    expect(call).toContain("if (next) proof = next;");
    expect(call).not.toMatch(/proof = ""/);
    expect(call).not.toContain("broke");
    expect(call).not.toContain("function (e)");
    expect(toolbarJs).not.toContain("broke()");
  });

  test("the panel takes the proof from its tag, strips it, and sends it with each call", () => {
    expect(toolbarJs).toContain('removeAttribute("data-proof")');
    expect(toolbarJs).toContain("x-forge-proof");
  });

  test("the clock is the real one again", () => {
    noteClock.now = () => Date.now();
  });

  test("the panel fits a phone and a desktop, and says no forge words first", () => {
    // 390x844: at most 320px wide within the viewport, and 70% high leaves the top (camera) clear.
    expect(toolbarJs).toContain("max-width:min(320px,calc(100vw - 64px))");
    expect(toolbarJs).toContain("max-height:min(70vh,calc(100vh - 88px))");
    expect(toolbarJs).toContain("Tell the builders");
    expect(toolbarJs).toContain("What is this?");
    expect(toolbarJs).toContain("font:16px");
  });

  test("an unknown /__forge/note* path is the app's, not the forge's", async () => {
    const res = await at("notes", "/__forge/notebook");
    // No app runs behind it here, so the proxy's own "unavailable" answers;
    // what matters is that the notes door did not claim it.
    expect(await res.text()).not.toContain("not_found");
    expect(res.headers.get("content-type") ?? "").not.toContain("json");
  });

  test("every /__forge/ answer wears the security floor, signed in and out", async () => {
    const signedIn = cookieOf(await post("Hello", "", "10.0.0.77"));
    const paths = ["/__forge/", "/__forge/crew", "/__forge/notes", "/__forge/note", "/__forge/note/moderate", "/__forge/measure", "/__forge/signin", "/__forge/signout", "/__forge/report", "/__forge/grant", "/__forge/grant?t=bad"];
    for (const slug of ["notes", "diary"]) {
      for (const cookie of ["", signedIn]) {
        for (const path of paths) {
          for (const method of ["GET", "POST"]) {
            const res = await at(slug, path, { method, ...(method === "POST" ? { body: "{}" } : {}) }, cookie, "10.0.0.78");
            const who = `${method} ${slug}${path} ${cookie ? "in" : "out"} -> ${res.status}`;
            expect(res.headers.get("x-content-type-options"), who).toBe("nosniff");
            expect(res.headers.get("referrer-policy"), who).toBeTruthy();
            const csp = res.headers.get("content-security-policy");
            expect(csp, who).toBeTruthy();
            if (!(res.headers.get("content-type") ?? "").startsWith("text/html"))
              expect(csp, who).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
            else {
              expect(csp, who).toContain("default-src");
              expect(csp, who).toContain("frame-ancestors 'none'");
            }
          }
        }
      }
    }
  });
});
