/**
 * Home is the feed (#599). Signed in, `/` is the composer above one
 * timeline: a tell is a post in its own words, a comment a reply under it,
 * each one tap from its thing; your apps are one step away. The composer
 * works without a script and refuses what the person may not read. The MCP
 * `feed` tool answers the same posts. Nothing private, nor an admin's
 * configuration, reaches a reader's timeline.
 */
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
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!r.ok) throw new Error(r.error);
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

  test("signed in, / is the composer above one timeline; your apps one step away", async () => {
    const text = await (await get("/", aliceCookie)).text();
    const composer = text.indexOf('id="composer"');
    const feed = text.indexOf('id="live-feed"');
    expect(composer).toBeGreaterThan(-1);
    expect(feed).toBeGreaterThan(composer);
    expect(text).toContain('action="/tell"');
    // A tell is a post in its own words, linking to it in one tap; a reply
    // carries what was said.
    expect(text).toContain("Water the tomatoes at dawn");
    expect(text).toMatch(
      /href="\/alice\/garden\/tells\/1"[^>]*data-feed-open>Water the tomatoes at dawn</,
    );
    // A reply names the tell it answers.
    expect(text).toContain("on “Water the tomatoes at dawn”: Mulch them first");
    // Every post's actions sit behind one quiet control, and "because you
    // own" — true of every post here — is not said again and again.
    expect(text).toContain('class="fcard-more"');
    expect(text).not.toContain("because you own alice/garden");
    // Your apps: a narrow column, and a tab on a phone.
    expect(text).toContain('id="live-apps"');
    expect(text).toContain('href="/apps"');
    expect(text).toContain('class="home-tabs seg"');
    // Nothing stands between the composer and the first post: the crew's
    // missing key sits beside the timeline (after it on a phone), and
    // "What you asked for" is a tab there.
    const note = text.indexOf('id="crew-key-note"');
    if (note !== -1) expect(note).toBeGreaterThan(feed);
    expect(text).toMatch(/class="home-tabs seg"[\s\S]*?href="\/asked"/);
    // The old home's shelf rows and cost line are /apps's now.
    expect(text).not.toContain("spent today across");
    const apps = await (await get("/apps", aliceCookie)).text();
    expect(apps).toContain("spent today across");
    // Each of the three pages carries the three tabs, so a phone has a way
    // back that is not only the logo.
    expect(apps).toMatch(/class="home-tabs seg"[\s\S]*?href="\/apps" aria-current="page"/);
    const asked = await (await get("/asked", aliceCookie)).text();
    expect(asked).toMatch(/class="home-tabs seg"[\s\S]*?href="\/asked" aria-current="page"/);
    expect(asked).toContain('href="/"');
    expect(text).toMatch(/class="home-tabs seg"[\s\S]*?href="\/" aria-current="page"/);
  });

  test("a reader's timeline has the public repository's posts and nothing private or configured", async () => {
    const text = await (await get("/", bobCookie)).text();
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

  test("On you can be cleared in one move: a box each, select all, by kind and by repository, one form", async () => {
    const one = openIssue(app, alice, garden, { title: "Sweep the path" });
    const two = openIssue(app, alice, vault, { title: "Oil the hinges" });
    if (!one.ok || !two.ok) throw new Error("issues");
    for (const [repo, issue] of [[garden, one.value], [vault, two.value]] as const)
      expect(assignIssue(app, alice, repo, issue, alice).ok).toBe(true);
    const text = await (await get("/", aliceCookie)).text();
    const card = text.slice(text.indexOf('id="live-on-you"')).replace(/\s+/g, " ");
    expect(card).toContain("On you");
    expect(card).toContain(`value="issue:${one.value.id}"`);
    expect(card).toContain(`value="issue:${two.value.id}"`);
    expect((card.match(/form="onyou-bulk"/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(card).toContain('data-pick="all"');
    expect(card).toContain("data-pick-repo");
    expect(card).toContain('<option value="' + garden.id + '">alice/garden</option>');
    expect(card).toContain('id="onyou-bulk"');
    expect(card).toContain('action="/asks/bulk"');
    expect(card).toContain('name="reason"');
    expect(card).toContain(">Mute repository<");
    // The live region follows the operation, and the page ships the script.
    expect(text).toContain("fleet.operated");
    expect(text).toContain("data-pick");
    expect(text).toContain('id="asks-link"');
    // Alone, a single row stays a plain link.
    const bobCard = await (await get("/", bobCookie)).text();
    expect(bobCard).not.toContain('id="onyou-bulk"');
  });
});
