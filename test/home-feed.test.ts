/**
 * Home is the feed (#599). Signed in, `/` is the composer above one
 * timeline: a tell is a post in its own words, a comment a reply under it,
 * each one tap from its thing; your apps are one step away. The composer
 * works without a script and refuses what the person may not read. The MCP
 * `feed` tool answers the same posts. Nothing private, nor an admin's
 * configuration, reaches a reader's timeline.
 */
import { freshHome } from "./helpers/home-fresh.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addComment, assignIssue, openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { listIssues } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { readFeed } from "../src/feed/feed.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

describe("home is the feed", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let aliceCookie: string;
  let bobCookie: string;
  let garden: Repo;
  let vault: Repo;

  const get = (path: string, cookie = "") =>
    fetch(`${servers.url}${path}`, {
      headers: { cookie: `${cookie}; forge_mode=studio` },
      redirect: "manual",
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-home-feed-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string, first = false) => {
      const r = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!r.ok) throw new Error(r.error);
      promote(app.db, r.value);
      return r.value;
    };
    await mk("keeper", true);
    alice = await mk("alice");
    bob = await mk("bob");
    aliceCookie = `forge_session=${createSession(app.db, alice.id).token}`;
    bobCookie = `forge_session=${createSession(app.db, bob.id).token}`;
    const g = await createRepo(app, alice, {
      name: "garden",
      visibility: "public",
    });
    const v = await createRepo(app, alice, {
      name: "vault",
      visibility: "private",
    });
    if (!g.ok || !v.ok) throw new Error("repos");
    garden = g.value;
    vault = v.value;
    for (const repo of [garden, vault])
      insertApp(app.db, { repoId: repo.id, slug: repo.name, access: "public" });
    const told = openIssue(app, alice, garden, {
      title: "Water the tomatoes at dawn",
    });
    if (!told.ok) throw new Error(String(told.error));
    const replied = addComment(
      app,
      bob,
      garden,
      told.value,
      "Mulch them first",
    );
    if (!replied.ok) throw new Error(String(replied.error));
    const hidden = openIssue(app, alice, vault, {
      title: "The combination is 4-8-15",
    });
    if (!hidden.ok) throw new Error(String(hidden.error));
    // A public repository whose app is private: its runs and pictures are
    // for those who may enter it, not for every reader.
    const lab = await createRepo(app, alice, { name: "lab", visibility: "public" });
    if (!lab.ok) throw new Error("lab");
    insertApp(app.db, { repoId: lab.value.id, slug: "lab", access: "private" });
    app.bus.append({
      kind: "run.finished",
      repoId: lab.value.id,
      actorId: alice.id,
      payload: { kind: "check", state: "ok", summary: "SECRET OUTPUT", runId: "rl" },
    });
    app.bus.append({
      kind: "look.taken",
      repoId: lab.value.id,
      actorId: alice.id,
      payload: { env: "production", commitOid: "0".repeat(40) },
    });
    // An admin's configuration on the public repository: never a reader's post.
    app.bus.append({
      kind: "webhook.created",
      repoId: garden.id,
      actorId: alice.id,
      payload: { url: "https://hooks.example/secret-token" },
    });
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the composer is a §5 card, and no .composer class remains", async () => {
    const text = await (await get("/feed", aliceCookie)).text();
    expect(text).toMatch(/<form id="composer" class="card" method="post" action="\/tell">\s*<div class="card-body/);
    expect(text).not.toContain('class="composer');
  });

  test("the composer's action bar is §5's bar, not .composer-bar", async () => {
    const text = await (await get("/feed", aliceCookie)).text();
    const form = text.slice(text.indexOf('id="composer"'), text.indexOf("</form>", text.indexOf('id="composer"')));
    expect(form).not.toContain("composer-bar");
    expect(form).toContain('<div class="bar">');
    expect(form).toContain('name="app"');
    expect(form).toContain("alice/garden");
    expect(form).toContain("the forge");
    expect(form).toMatch(/>\s*Post\s*</);
  });

  test("signed in, / is the composer above one timeline; your apps one step away", async () => {
    const text = await (await get("/feed", aliceCookie)).text();
    const composer = text.indexOf('id="composer"');
    const feed = text.indexOf('id="live-feed"');
    expect(composer).toBeGreaterThan(-1);
    expect(feed).toBeGreaterThan(composer);
    expect(text).toContain('action="/tell"');
    // A tell is a post in its own words, linking to it in one tap; a reply
    // carries what was said.
    expect(text).toContain("Water the tomatoes at dawn");
    expect(text).toMatch(
      /href="\/alice\/garden\/issues\/1"[^>]*data-feed-open>opened an issue: Water the tomatoes at dawn</,
    );
    // A reply names the tell it answers.
    expect(text).toContain("on “Water the tomatoes at dawn”: Mulch them first");
    // Every post's actions sit behind one quiet control, and "because you
    // own" — true of every post here — is not said again and again.
    expect(text).toContain('class="disclosure"');
    expect(text).not.toContain("because you own alice/garden");
    // Your apps: a narrow column, and a tab on a phone.
    expect(text).toContain('id="live-apps"');
    expect(text).toContain('href="/apps"');
    expect(text).toContain('class="tabs"');
    expect(text).not.toContain("home-tabs");
    // Nothing stands between the composer and the first post: the crew's
    // missing key sits beside the timeline (after it on a phone), and
    // "What you asked for" is the Asked tab, the one door to /asked.
    expect(text).not.toContain("feed-head");
    expect(text).not.toContain('href="/asked">What you asked for');
    const note = text.indexOf('id="crew-key-note"');
    if (note !== -1) expect(note).toBeGreaterThan(feed);
    expect(text).toMatch(/class="tabs"[\s\S]*?href="\/asked"/);
    // The old home's shelf rows and cost line are /apps's now.
    expect(text).not.toContain("spent today across");
    const apps = await (await get("/apps", aliceCookie)).text();
    expect(apps).toContain("spent today across");
    // Each of the three pages carries the three tabs, so a phone has a way
    // back that is not only the logo.
    expect(apps).toMatch(/class="tabs"[\s\S]*?href="\/apps"\s+aria-current="page"/);
    const asked = await (await get("/asked", aliceCookie)).text();
    expect(asked).toMatch(/class="tabs"[\s\S]*?href="\/asked"\s+aria-current="page"/);
    expect(asked).toContain('href="/"');
    expect(text).toMatch(/class="tabs"[\s\S]*?href="\/feed"\s+aria-current="page"/);
    for (const page of [apps, asked]) {
      expect(page).not.toContain("home-tabs");
      for (const w of ["Feed", "Your apps", "Asked"]) expect(page).toContain(w);
    }
  });

  test("a reader's timeline has the public repository's posts and nothing private or configured", async () => {
    const text = await (await get("/feed", bobCookie)).text();
    expect(text).toContain("Water the tomatoes at dawn");
    expect(text).not.toContain("The combination is 4-8-15");
    expect(text).not.toContain("alice/vault");
    expect(text).not.toContain("secret-token");
    const items = readFeed(app.db, bob).items;
    expect(items.some((i) => i.app === "alice/vault")).toBe(false);
    expect(JSON.stringify(items)).not.toContain("secret-token");
    // The private app's run and picture: not a reader's posts.
    expect(JSON.stringify(items)).not.toContain("SECRET OUTPUT");
    expect(items.some((i) => i.app === "alice/lab")).toBe(false);
    // Its owner sees both.
    const owners = readFeed(app.db, alice, { limit: 50 }).items.filter((i) => i.app === "alice/lab");
    expect(owners.map((i) => i.kind).sort()).toEqual(["look", "run"]);
  });

  test("the installed icon's long-press offers On you and Talk, same-origin pages that answer", async () => {
    const manifest = (await fetch(`${servers.url}/manifest.webmanifest`).then((r) => r.json())) as {
      shortcuts: { name: string; short_name: string; url: string; icons: { src: string }[] }[];
    };
    expect(manifest.shortcuts.map((s) => [s.short_name, s.url])).toEqual([
      ["On you", "/asks"],
      ["Talk", "/talk"],
    ]);
    for (const s of manifest.shortcuts) {
      expect(s.icons[0]!.src).toBe("/icons/forge-192.png");
      expect(new URL(s.url, servers.url).origin).toBe(servers.url);
      const signedIn = await get(s.url, aliceCookie);
      expect(signedIn.status).toBe(200);
      const anon = await fetch(`${servers.url}${s.url}`, { redirect: "manual" });
      expect(anon.status).toBe(303);
      expect(anon.headers.get("location")).toBe(`/signin?next=${encodeURIComponent(s.url)}`);
    }
  });

  test("a phone's share sheet opens the composer with the shared words, escaped, and sends nothing", async () => {
    const manifest = (await fetch(`${servers.url}/manifest.webmanifest`).then((r) =>
      r.json(),
    )) as { share_target: { action: string; method: string; params: Record<string, string> } };
    expect(manifest.share_target).toEqual({
      action: "/",
      method: "GET",
      params: { title: "title", text: "text", url: "url" },
    });
    const before = listIssues(app.db, garden.id, { state: "open" }).length;
    const q = new URLSearchParams({
      title: "Rain gauges",
      text: 'Look at this </textarea><script>alert(1)</script>',
      url: "https://example.com/gauge",
    });
    const res = await get(`/feed?${q}`, aliceCookie);
    const text = await res.text();
    const box = /<textarea[^>]*name="text"[^>]*>([\s\S]*?)<\/textarea>/.exec(text);
    expect(box?.[1]).toContain("Rain gauges\nLook at this &lt;/textarea&gt;&lt;script&gt;");
    expect(box?.[1]).toContain("https://example.com/gauge");
    expect(text).not.toContain("<script>alert(1)");
    expect(listIssues(app.db, garden.id, { state: "open" }).length).toBe(before);
    // A link the app put in the text as well is said once.
    const twice = await get(
      `/?${new URLSearchParams({ text: "see https://e.com/x", url: "https://e.com/x" })}`,
      aliceCookie,
    ).then((r) => r.text());
    expect(twice.match(/https:\/\/e\.com\/x/g)?.length).toBe(1);
  });

  test("a signed-out share keeps its words through sign-in and sign-up", async () => {
    const q = `?${new URLSearchParams({ text: "see this", url: "https://e.com/x" })}`;
    const page = await get(`/${q}`).then((r) => r.text());
    const next = encodeURIComponent(`/${q}`).replaceAll("&", "&amp;");
    expect(page).toContain(`/signin?next=${next}`);
    expect(page).toContain(`/signup?next=${next}`);
    const bare = await get("/").then((r) => r.text());
    expect(bare).toContain('href="/signin"');
  });

  test("the composer posts a tell without a script, to an app the person may read, and only then", async () => {
    const before = listIssues(app.db, garden.id, { state: "open" }).length;
    const posted = await fetch(`${servers.url}/tell`, {
      method: "POST",
      headers: { cookie: aliceCookie, origin: servers.url },
      body: new URLSearchParams({
        app: "alice/garden",
        text: "Add a rain gauge",
      }),
      redirect: "manual",
    });
    expect(posted.status).toBe(303);
    expect(posted.headers.get("location")).toBe("/");
    expect(listIssues(app.db, garden.id, { state: "open" }).length).toBe(
      before + 1,
    );
    // A repository the person cannot read is not there.
    const refused = await fetch(`${servers.url}/tell`, {
      method: "POST",
      headers: { cookie: bobCookie, origin: servers.url },
      body: new URLSearchParams({ app: "alice/vault", text: "Open it" }),
      redirect: "manual",
    });
    expect(refused.status).toBe(404);
    // Nobody signed in is asked to sign in; another site's form is refused.
    const stranger = await fetch(`${servers.url}/tell`, {
      method: "POST",
      body: new URLSearchParams({ app: "alice/garden", text: "hi" }),
      redirect: "manual",
    });
    expect([302, 303]).toContain(stranger.status);
    const forged = await fetch(`${servers.url}/tell`, {
      method: "POST",
      headers: { cookie: aliceCookie, origin: "https://evil.example" },
      body: new URLSearchParams({ app: "alice/garden", text: "hi" }),
      redirect: "manual",
    });
    expect(forged.status).toBe(403);
    // The one tell's refusals: an unverified writer is told to verify, and
    // nothing is opened.
    app.db.query(`UPDATE email_check SET verified_at = NULL WHERE user_id = ?1`).run(alice.id);
    try {
      const open = listIssues(app.db, garden.id, { state: "open" }).length;
      const unverified = await fetch(`${servers.url}/tell`, {
        method: "POST",
        headers: { cookie: aliceCookie, origin: servers.url },
        body: new URLSearchParams({ app: "alice/garden", text: "Prune the roses" }),
        redirect: "manual",
      });
      expect(unverified.status).toBe(303);
      expect(decodeURIComponent(unverified.headers.get("set-cookie") ?? "")).toContain(
        "Verify your email first",
      );
      expect(listIssues(app.db, garden.id, { state: "open" }).length).toBe(open);
    } finally {
      app.db
        .query(`UPDATE email_check SET verified_at = ?1 WHERE user_id = ?2`)
        .run(new Date().toISOString(), alice.id);
    }
  });

  test("the composer can send to the forge: a thought, verbatim, shown escaped as the owner's received post", async () => {
    const text = "  <script>alert(1)</script> & more\n\tsecond line ";
    const sent = await fetch(`${servers.url}/tell`, {
      method: "POST",
      headers: { cookie: aliceCookie, origin: servers.url },
      body: new URLSearchParams({ app: "forge", text }),
      redirect: "manual",
    });
    expect(sent.status).toBe(303);
    const row = app.db
      .query<{ text: string; source: string }, [string]>(
        "SELECT text, source FROM thought WHERE author = ?1",
      )
      .get(alice.id);
    expect(row).toEqual({ text, source: "composer" });
    const page = await freshHome(servers.url, `${aliceCookie}; forge_mode=studio`, "/feed");
    expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; more");
    expect(page).not.toContain("<script>alert(1)</script>");
    expect(page).toContain("Received");
    expect(page).toContain('<option value="forge">the forge</option>');
    // It is the author's alone, and another site's form is refused.
    const bobs = await freshHome(servers.url, `${bobCookie}; forge_mode=studio`, "/feed");
    expect(bobs).not.toContain("alert(1)");
    const forged = await fetch(`${servers.url}/tell`, {
      method: "POST",
      headers: { cookie: aliceCookie, origin: "https://evil.example" },
      body: new URLSearchParams({ app: "forge", text: "nope" }),
      redirect: "manual",
    });
    expect(forged.status).toBe(403);
    expect(app.db.query("SELECT count(*) AS n FROM thought").get()).toEqual({ n: 1 });
  });

  test("a person with no apps can still send to the forge, and a day-old thought leaves the feed", async () => {
    const empty = await freshHome(servers.url, `${bobCookie}; forge_mode=studio`, "/feed");
    expect(empty).toContain('name="app" value="forge"');
    expect(empty).toContain("No apps yet");
    const old = new Date(Date.now() - 2 * 86_400_000).toISOString();
    app.db
      .query("INSERT INTO thought (id, author, text, source, received_at) VALUES ('old1', ?1, 'ancient musing', 'composer', ?2)")
      .run(bob.id, old);
    expect(await freshHome(servers.url, `${bobCookie}; forge_mode=studio`, "/feed")).not.toContain("ancient musing");
    await fetch(`${servers.url}/tell`, {
      method: "POST",
      headers: { cookie: bobCookie, origin: servers.url },
      body: new URLSearchParams({ app: "forge", text: "fresh musing" }),
      redirect: "manual",
    });
    const after = await freshHome(servers.url, `${bobCookie}; forge_mode=studio`, "/feed");
    expect(after).toContain("fresh musing");
    expect(after).not.toContain("ancient musing");
  });

  test("a release post reads the version and first pull, links the commit, and falls back without a version", async () => {
    const oid = "a".repeat(40);
    const serving = (payload: Record<string, unknown>) =>
      app.bus.append({ kind: "app.serving", repoId: garden.id, payload: { app: "garden", env: "production", commitOid: oid, ...payload } });
    serving({ version: "0.7.251", pulls: [{ title: "Water <b>early</b>", number: 1 }, { title: "Mulch", number: 2 }, { title: "Weed", number: 3 }] });
    const page = await freshHome(servers.url, `${aliceCookie}; forge_mode=studio`, "/feed");
    expect(page).toContain("0.7.251 is serving: Water &lt;b&gt;early&lt;/b&gt; and 2 more");
    expect(page).not.toContain("<b>early</b>");
    expect(page).toContain(`href="/alice/garden/commit/${oid}"`);
    const mcp = async () => {
      const token = createToken(app.db, alice.id, "rel", "ro").token;
      const res = await fetch(`${servers.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "feed", arguments: { limit: 50 } } }),
      });
      return JSON.parse(((await res.json()) as any).result.content[0].text).items as any[];
    };
    const rel = (await mcp()).filter((i) => i.what.includes("is serving"));
    expect(rel[0].what).toBe("0.7.251 is serving: Water <b>early</b> and 2 more");
    expect(rel[0].link).toBe(`/alice/garden/commit/${oid}`);
    serving({ version: "not-a-version", pulls: [{ title: "Nope", number: 4 }] });
    const items = (await mcp()).filter((i) => i.what === "a new version is serving");
    expect(items.length).toBe(1);
    expect(items[0].link).toBe("/alice/garden");
  });

  test("the MCP feed answers the same posts, page by page", async () => {
    const token = createToken(app.db, alice.id, "ro", "ro").token;
    const call = async (args: unknown) => {
      const res = await fetch(`${servers.url}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "feed", arguments: args },
        }),
      });
      const body = (await res.json()) as any;
      return JSON.parse(body.result.content[0].text);
    };
    const whole = readFeed(app.db, alice, { limit: 50 }).items.map((i) => i.id);
    const first = await call({ limit: 2 });
    expect(first.items.map((i: any) => i.id)).toEqual(whole.slice(0, 2));
    expect(first.items[0].what).toBeDefined();
    expect(first.next_cursor).not.toBeNull();
    const second = await call({ limit: 2, cursor: first.next_cursor });
    expect(second.items.map((i: any) => i.id)).toEqual(whole.slice(2, 4));
  });

  test("six open asks fill /asks and leave the home bare: no titles, no section, no count", async () => {
    const titles = ["Ask alpha", "Ask bravo", "Ask charlie", "Ask delta", "Ask echo", "Ask foxtrot"];
    for (const title of titles) {
      const made = openIssue(app, bob, garden, { title });
      if (!made.ok) throw new Error("issue");
      expect(assignIssue(app, alice, garden, made.value, alice).ok).toBe(true);
    }
    const page = await (await get("/feed", aliceCookie)).text();
    // The timeline may still tell of a filed issue as a post; the asks are
    // what must be gone, so the page is read up to the timeline.
    const home = page.slice(0, page.indexOf('id="live-feed"'));
    expect(home.length).toBeGreaterThan(0);
    for (const title of titles) expect(home).not.toContain(title);
    expect(page).not.toContain("live-on-you");
    expect(home).not.toContain("things need you");
    expect(home).not.toContain("data-pick");
    expect(home).toContain('href="/asks"');
    const link = home.match(/<a[^>]*href="\/asks"[^>]*>([^<]*)(?:<kbd class="keyhint">.*?<\/kbd>)?<\/a\s*>/s);
    expect(link).not.toBeNull();
    expect(link![1]!.trim()).toBe("Asks");
    // Nothing after the link, up to the next tag, is a number.
    const after = home.slice(home.indexOf(link![0]) + link![0].length);
    expect(after.slice(0, after.indexOf("<")).trim()).not.toMatch(/\d/);
    // The Asks chord is its own: no two elements on the page share one.
    const chords = [...page.matchAll(/data-shortcut="([^"]+)"/g)].map((m) => m[1]);
    expect(chords).toContain("g q");
    expect(new Set(chords).size).toBe(chords.length);
    const asks = await (await get("/asks", aliceCookie)).text();
    for (const title of titles) expect(asks).toContain(title);
  });

  test("The one list can be cleared in one move: a box each, select all, by kind and by repository, one form", async () => {
    const one = openIssue(app, alice, garden, { title: "Sweep the path" });
    const two = openIssue(app, alice, vault, { title: "Oil the hinges" });
    if (!one.ok || !two.ok) throw new Error("issues");
    for (const [repo, issue] of [[garden, one.value], [vault, two.value]] as const)
      expect(assignIssue(app, alice, repo, issue, alice).ok).toBe(true);
    const text = await (await get("/asks", aliceCookie)).text();
    const card = text.slice(text.indexOf('id="live-on-you"')).replace(/\s+/g, " ");
    expect(card).toContain("things need you");
    expect(card).toContain("assigned to you");
    expect(card).toContain(`value="assigned:${one.value.id}"`);
    expect(card).toContain(`value="assigned:${two.value.id}"`);
    expect((card.match(/form="asks-bulk"/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(card).toContain('data-pick="all"');
    expect(card).toContain("data-pick-repo");
    expect(card).toContain('<option value="' + garden.id + '">alice/garden</option>');
    expect(card).toContain('id="asks-bulk"');
    expect(card).toContain('action="/asks/bulk"');
    expect(card).toContain('name="reason"');
    expect(card).toContain(">Mute repository<");
    // The live region follows the operation, and the page ships the script.
    expect(text).toContain("fleet.operated");
    expect(text).toContain("data-pick");
    // Alone, a single row stays a plain link.
    const bobCard = await (await get("/asks", bobCookie)).text();
    expect(bobCard).not.toContain('id="asks-bulk"');
  });
});
