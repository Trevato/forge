/**
 * A client's first screen (#1812): signed in through a child forge's claim
 * link, a person sees their apps, one plain line each and whether its agents
 * work or wait; no map, board or settings until asked, and none of the
 * developer's words.
 */

import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { childDirOf, spawnForge } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { getAppByRepo } from "../src/core/apps.ts";
import { clientApps } from "../src/web/studio/client_home.ts";
import type { Ctx } from "../src/http/context.ts";
import { clientAppRows, cutTitle, doingLine } from "../src/core/client-apps.ts";
import { addCrew, createAgentRow } from "../src/core/agents.ts";
import { moveArchived } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { linkEveryday } from "../src/core/everyday.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { commitFiles } from "../src/git/write.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { firstBoot } from "../src/spawn/first-boot.ts";
import { hostedPlacement } from "../src/spawn/placement.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";
import { passkeyFields } from "./helpers/passkey.ts";

quietLogs();

const PASSWORD = "a-long-first-login-passphrase";
const FORGE_JSON = JSON.stringify({
  app: { run: "bun run index.ts", health: "/" },
});

describe("a client's first screen", () => {
  let dir = "";
  let parent: App;
  let parentServers: Servers;
  let child: App;
  let servers: Servers;
  let owner = "";

  const url = (path: string) => `${servers.url}${path}`;
  const page = async (cookie: string, path = "/") =>
    (await (await fetch(url(path), { headers: { cookie } })).text()).replace(
      /\s+/g,
      " ",
    );
  const post = (cookie: string, path: string, form: Record<string, string>) =>
    fetch(url(path), {
      method: "POST",
      headers: { cookie, origin: servers.url },
      body: new URLSearchParams(form),
      redirect: "manual",
    });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-first-login-"));
    parent = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
    const made = await createUser(parent.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "a@x.test",
      password: PASSWORD,
      isAdmin: true,
    });
    if (!made.ok) throw new Error("user");
    const alice = made.value;
    const repo = await createRepo(parent, alice, { name: "bakery" });
    if (!repo.ok) throw new Error("repo");
    const c = await commitFiles(repoDir(parent.reposRoot, "alice", "bakery"), {
      branch: "main",
      message: "bakery",
      files: [
        { path: "forge.json", content: FORGE_JSON },
        {
          path: "index.ts",
          content: "Bun.serve({fetch(){return new Response('hi')}})\n",
        },
      ],
      author: { name: "a", email: "a@x.invalid" },
    });
    if (!c.ok) throw new Error("commit");
    const atlas = await createUser(parent.db, {
      origin: "seed",
      username: "atlas",
      email: "atlas@a.invalid",
      agent: true,
    });
    if (!atlas.ok) throw new Error("agent");
    createAgentRow(parent.db, {
      userId: atlas.value.id,
      brief: "plan",
      createdBy: alice.id,
    });
    addCrew(parent.db, repo.value.id, atlas.value.id, alice.id);
    seatAs(parent.db, repo.value.id, atlas.value.id, "planner");
    parentServers = await serve(parent);
    const spawned = await spawnForge(
      parent,
      alice,
      {
        name: "maria",
        org: "marias",
        apps: ["alice/bakery"],
        carryBriefs: true,
        carrySubscriptions: false,
        direction: "Run Maria's bakery.",
      },
      {
        catalog: [
          { ref: "alice/bakery", readable: true, bytes: 10, forgeJsonBytes: 0 },
        ],
        briefs: [{ agent: "atlas", text: "plan" }],
        subscriptions: [],
      },
      {
        placement: hostedPlacement({ host: "forge.test" }),
        request: new Request("https://forge.test/x", {
          method: "POST",
          headers: { origin: "https://forge.test" },
        }),
        url: new URL("https://forge.test/x"),
      },
    );
    if (!spawned.ok) throw new Error(JSON.stringify(spawned.error));
    child = createApp({
      dataDir: childDirOf(parent, spawned.value.bodyId),
      port: 0,
    });
    await firstBoot(child);
    servers = await serve(child);
    const link = spawned.value.claimUrl!;
    const token = link.split("/claim#")[1]!;
    const claimed = await fetch(url("/claim"), {
      method: "POST",
      headers: { origin: servers.url },
      body: new URLSearchParams({
        ...{ token, username: "maria", email: "maria@bakery.test" },
        ...(await passkeyFields(servers.url, "/claim/options", { token, username: "maria", email: "maria@bakery.test" })),
      }),
      redirect: "manual",
    });
    if (claimed.status !== 303) throw new Error(`claim ${claimed.status}`);
    owner = (claimed.headers.get("set-cookie") ?? "").split(";")[0]!;
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    child.close();
    parentServers.stop();
    parent.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** What the page itself says, below the bar every page has. */
  const main = (html: string): string => html.slice(html.indexOf("<main"));
  const words = (html: string): string =>
    main(html)
      .replace(/<(script|style)[\s\S]*?<\/\1>/g, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ");

  test("the home is their apps, each a sentence and a line on its agents, with no map, board or settings", async () => {
    const home = main(await page(owner));
    const apps = home.slice(home.indexOf('id="client-apps"'));
    expect(apps).toContain('href="/marias/bakery"');
    expect(apps).toMatch(/data-agents="(working|waiting)"/);
    expect(apps).toContain("agents are waiting");
    expect(home).not.toContain('id="live-chips"');
    for (const gone of ['href="/map"', 'href="/board"', 'href="/audit"', 'href="/settings"'])
      expect(home).not.toContain(gone);
    expect(home).toContain('href="/?all=1"');
  });

  test("each app offers Ask for something, which opens the tell form for it, and sending lands back here", async () => {
    const home = main(await page(owner));
    expect(home).toContain('href="/marias/bakery/tell?from=/&amp;ask=1"');
    expect(home).toContain("Ask for something");
    const form = await page(owner, "/marias/bakery/tell?from=/&ask=1");
    expect(form).toContain('action="/marias/bakery/tell"');
    expect(form).toContain('name="ask" value="1"');
    expect(form).not.toContain("From <code>");
    const sent = await post(owner, "/marias/bakery/tell", { text: "Add a rye loaf", from: "/", ask: "1" });
    expect(sent.status).toBe(303);
    expect(new URL(sent.headers.get("location")!, servers.url).pathname).toBe("/");
    const flash = sent.headers.get("set-cookie")!.split(";")[0]!;
    expect(await page(`${owner}; ${flash}`)).toContain("Sent. The agents will pick it up.");
  });

  test("a tell sent from / without asking keeps its routed line", async () => {
    const sent = await post(owner, "/marias/bakery/tell", { text: "Add a plain loaf", from: "/" });
    const flash = decodeURIComponent(sent.headers.get("set-cookie")!);
    expect(flash).not.toContain("Sent. The agents will pick it up.");
  });

  test("the link keeps the same-origin rule: a tell from another origin is refused", async () => {
    const res = await fetch(url("/marias/bakery/tell"), {
      method: "POST",
      headers: { cookie: owner, origin: "https://evil.test" },
      body: new URLSearchParams({ text: "x", from: "/" }),
      redirect: "manual",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("a viewer who may not tell is offered no link", async () => {
    const reader = await createUser(child.db, {
      origin: "seed",
      trusted: true,
      username: "lookeronly",
      email: "lo@x.test",
      password: PASSWORD,
    });
    if (!reader.ok) throw new Error("reader");
    child.db.query("UPDATE repo SET visibility = 'public' WHERE name = 'bakery'").run();
    try {
      const ctx = {
        app: child,
        request: new Request("https://x.test/"),
        auth: { user: reader.value },
      } as unknown as Ctx;
      const shown = String(await clientApps(ctx, reader.value));
      expect(shown).toContain('href="/marias/bakery"');
      expect(shown).not.toContain("Ask for something");
      const maria = getUserByName(child.db, "maria")!;
      expect(String(await clientApps(ctx, maria))).toContain("Ask for something");
    } finally {
      child.db.query("UPDATE repo SET visibility = 'private' WHERE name = 'bakery'").run();
    }
  });

  test("a running app offers Open to its live address; one that is not offers nothing", async () => {
    const maria = getUserByName(child.db, "maria")!;
    const repo = child.db.query<{ id: string }, []>("SELECT id FROM repo WHERE name = 'bakery'").get()!;
    const runtime = new AppsRuntime(child, { domain: "apps.test", scheme: "https", forgeUrl: "https://forge.test" });
    try {
      const record = getAppByRepo(child.db, repo.id);
      if (record === undefined) throw new Error("no app record");
      let state = "stopped";
      runtime.status = () => [{ env: "production", state }] as never;
      const ctx = { app: child, request: new Request("https://x.test/"), auth: { user: maria } } as unknown as Ctx;
      const text = (h: string): string => h.replace(/<[^>]*>/g, " ");
      const opens = async () => String(await clientApps(ctx, maria));

      const down = await opens();
      expect(down).not.toContain(">Open<");
      expect(down).not.toContain("/app/production/open");
      expect(down).toContain('href="/marias/bakery"');

      state = "running";
      const up = await opens();
      expect(up).toContain('href="/marias/bakery/app/production/open"');
      expect(up).toContain(">Open<");
      expect(up).toContain('href="/marias/bakery"');
      expect(runtime.urlFor(record, "production")).toStartWith("https://");
      for (const shown of [up, down])
        for (const word of ["deploy", "process", "port"])
          expect(text(shown)).not.toMatch(new RegExp(`\\b${word}`, "i"));

      // The terminal offers the same: a marker on the running app and `o` for its address.
      const terminal = headlessTerminal(120, 30);
      const { app } = createForgeApp(
        child,
        { sshUsername: "maria", remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user: maria },
        { terminal, exitHooks: false },
      );
      app.start();
      await settleApp(app);
      expect(app.screen.toText()).toContain("bakery (running, o opens it): ");
      terminal.feed("o");
      await settleApp(app);
      expect(app.screen.toText()).toContain(runtime.urlFor(record, "production"));
      app.stop();

      state = "stopped";
      const idle = headlessTerminal(120, 30);
      const stopped = createForgeApp(
        child,
        { sshUsername: "maria", remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user: maria },
        { terminal: idle, exitHooks: false },
      );
      stopped.app.start();
      await settleApp(stopped.app);
      expect(stopped.app.screen.toText()).toContain("bakery: Its agents");
      expect(stopped.app.screen.toText()).not.toContain("running");
      idle.feed("o");
      await settleApp(stopped.app);
      expect(stopped.app.screen.toText()).not.toContain("https://");
      stopped.app.stop();
    } finally {
      await runtime.stop();
    }
  });

  test("the terminal's first screen asks for something with t, in the web's words", async () => {
    const maria = getUserByName(child.db, "maria")!;
    const terminal = headlessTerminal(120, 30);
    const { app } = createForgeApp(
      child,
      { sshUsername: "maria", remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user: maria },
      { terminal, exitHooks: false },
    );
    app.start();
    await settleApp(app);
    for (const k of ["t", ..."a rye loaf".split(""), "\r"]) {
      terminal.feed(k);
      await settleApp(app);
    }
    expect(app.screen.toText()).toContain("Sent. The agents will pick it up.");
    const told = child.db.query("SELECT COUNT(*) AS n FROM issue WHERE title LIKE '%rye loaf%'").get() as { n: number };
    expect(told.n).toBeGreaterThan(0);
    app.stop();
  });

  test("a running agent turns the line to working", async () => {
    const repo = child.db
      .query<{ id: string }, []>("SELECT id FROM repo WHERE name = 'bakery'")
      .get()!;
    child.db
      .query("INSERT INTO run (id, repo_id, kind, state) VALUES ('r-client-1', ?1, 'agent', 'running')")
      .run(repo.id);
    const home = await page(owner);
    expect(home).toContain('data-agents="working"');
    expect(home).toContain("One agent is working on it now.");
    child.db.query("DELETE FROM run WHERE id = 'r-client-1'").run();
  });

  test("the card refreshes itself: /live/client-apps answers it, to a client only", async () => {
    const repo = child.db
      .query<{ id: string }, []>("SELECT id FROM repo WHERE name = 'bakery'")
      .get()!;
    expect(await page(owner)).toContain('data-live-src="/live/client-apps"');
    child.db
      .query("INSERT INTO run (id, repo_id, kind, state) VALUES ('r-client-2', ?1, 'agent', 'running')")
      .run(repo.id);
    const live = await page(owner, "/live/client-apps");
    expect(live).toContain('id="client-apps"');
    expect(live).toContain("One agent is working on it now.");
    child.db.query("DELETE FROM run WHERE id = 'r-client-2'").run();
    expect((await fetch(url("/live/client-apps"))).status).toBe(404);
  });

  test("none of the developer's words appear on it, composer included", async () => {
    const text = words(await page(owner));
    expect(text).toContain("Your apps");
    for (const word of ["pull", "branch", "commit", "merge", "CI", "repository", "repositories"])
      expect(text).not.toMatch(new RegExp(`\\b${word}`, "i"));
  });

  test("asked for, the whole home is still there", async () => {
    const home = await page(owner, "/?all=1");
    expect(home).toContain('id="live-chips"');
    expect(home).not.toContain('id="client-apps"');
  });

  test("a plain reader gets the ordinary home", async () => {
    const reader = await createUser(child.db, {
      origin: "seed",
      trusted: true,
      username: "reader",
      email: "r@x.test",
      password: PASSWORD,
    });
    if (!reader.ok) throw new Error("reader");
    const session = createSession(child.db, reader.value.id);
    expect(await page(`forge_session=${session.token}`)).not.toContain('id="client-apps"');
    const live = await fetch(url("/live/client-apps"), { headers: { cookie: `forge_session=${session.token}` } });
    expect(live.status).toBe(404);
  });

  const visibleWords = async (cookie: string): Promise<string> => {
    const all = main(await page(cookie));
    // The composer's form; the command palette beside it is the bar's, not the home's.
    const from = all.indexOf('id="composer"');
    const m = all.slice(from, all.indexOf("</form>", from));
    const attrs = [...m.matchAll(/\b(?:placeholder|aria-label|title|alt)="([^"]*)"/g)]
      .map((x) => x[1])
      .join(" ");
    return `${words(m)} ${attrs}`;
  };

  test("the composer's words, labels and placeholders carry none either", async () => {
    const home = await page(owner);
    expect(home).toContain('id="composer"');
    const text = await visibleWords(owner);
    for (const word of ["pull", "branch", "commit", "merge", "repository", "repositories"])
      expect(text).not.toMatch(new RegExp(`\\b${word}`, "i"));
  });

  test("the lean home ships no live-update script and the whole home links back to it", async () => {
    expect(await page(owner)).not.toContain("EventSource");
    const all = await page(owner, "/?all=1");
    expect(all).toContain('id="lean-home"');
    expect(all).toContain('href="/"');
  });

  test("a client sees no forge-wide figures, lean or whole", async () => {
    expect(await page(owner)).not.toContain('class="stats kpi-row mb"');
    expect(await page(owner, "/?all=1")).not.toContain('class="stats kpi-row mb"');
  });

  test("queued agents and no running ones read as about to start", async () => {
    const repo = child.db
      .query<{ id: string }, []>("SELECT id FROM repo WHERE name = 'bakery'")
      .get()!;
    child.db
      .query("INSERT INTO run (id, repo_id, kind, state) VALUES ('r-client-2', ?1, 'agent', 'queued')")
      .run(repo.id);
    const home = await page(owner);
    expect(home).toContain("Its agents are about to start.");
    expect(home).toContain('data-agents="waiting"');
    child.db.query("DELETE FROM run WHERE id = 'r-client-2'").run();
  });

  test("an everyday account that cannot see the apps is told they will appear, and no more", async () => {
    const maria = getUserByName(child.db, "maria")!;
    const daily = await createUser(child.db, {
      origin: "seed",
      trusted: true,
      username: "mariadaily",
      email: "md@x.test",
      password: PASSWORD,
    });
    if (!daily.ok) throw new Error(JSON.stringify(daily.error));
    linkEveryday(child.db, maria, daily.value);
    const cookie = `forge_session=${createSession(child.db, daily.value.id).token}`;
    const home = await page(cookie);
    expect(home).toContain('id="client-apps"');
    expect(home).toContain("Your apps will appear here.");
    expect(home).not.toContain('href="/marias/bakery"');
  });

  test("the terminal's first screen says the same about each app", async () => {
    const maria = getUserByName(child.db, "maria")!;
    const terminal = headlessTerminal(120, 30);
    const { app } = createForgeApp(
      child,
      { sshUsername: "maria", remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user: maria },
      { terminal, exitHooks: false },
    );
    app.start();
    await settleApp(app);
    expect(app.screen.toText()).toContain("bakery: Its agents are waiting for something to do.");
    expect(app.screen.toText()).toMatch(/Atlas is ready to work toward Run Maria/);
    expect(app.screen.toText()).not.toContain("Shipped per hour");
    app.stop();
  });

  test("an archived app leaves the first screen and comes back when woken", async () => {
    const maria = getUserByName(child.db, "maria")!;
    const second = await createRepo(child, maria, { name: "cafe", owner: "marias" });
    if (!second.ok) throw new Error(JSON.stringify(second.error));
    const bakery = child.db
      .query<{ id: string }, []>("SELECT id FROM repo WHERE name = 'bakery'")
      .get()!;
    const names = async () =>
      (await clientAppRows(child, maria)).map((r) => r.repo.name).sort();
    expect(await names()).toEqual(["bakery", "cafe"]);
    expect(moveArchived(child.db, bakery.id, true)).toBe(true);
    expect(await names()).toEqual(["cafe"]);
    const apps = async () => {
      const home = main(await page(owner));
      return home.slice(home.indexOf('id="client-apps"'));
    };
    expect(await apps()).not.toContain('href="/marias/bakery"');
    expect(await apps()).toContain('href="/marias/cafe"');
    expect((await fetch(url("/marias/bakery"), { headers: { cookie: owner } })).status).toBe(200);
    expect(moveArchived(child.db, bakery.id, false)).toBe(true);
    expect(await names()).toEqual(["bakery", "cafe"]);
    expect(await apps()).toContain('href="/marias/bakery"');
  });

  describe("what each app is doing", () => {
    const ids = () => {
      const maria = getUserByName(child.db, "maria")!;
      const repo = child.db
        .query<{ id: string }, []>("SELECT id FROM repo WHERE name = 'bakery'")
        .get()!;
      return { maria, repo };
    };
    const seedIssue = (id: string, n: number, kind: string, title: string, state: string) => {
      const { maria, repo } = ids();
      child.db
        .query(
          "INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state) VALUES (?1, ?2, ?3, ?4, ?5, '', ?6, ?7)",
        )
        .run(id, repo.id, n, kind, title, maria.id, state);
    };
    const clean = () => {
      child.db.query("DELETE FROM run WHERE id LIKE 'r-doing-%'").run();
      child.db.query("DELETE FROM pull WHERE issue_id LIKE 'i-doing-%'").run();
      child.db.query("DELETE FROM issue WHERE id LIKE 'i-doing-%'").run();
    };
    const row = async (): Promise<string> => {
      const home = main(await page(owner));
      const from = home.indexOf('href="/marias/bakery"');
      return home.slice(from, home.indexOf("</li>", from));
    };

    test("a quiet app gets no extra line", async () => {
      clean();
      expect(await row()).not.toContain("client-app-doing");
    });

    test("work running now reads Working on, escaped", async () => {
      clean();
      seedIssue("i-doing-1", 9001, "issue", "Add <b>rye</b> bread", "open");
      child.db
        .query("INSERT INTO run (id, repo_id, kind, state, issue_id) VALUES ('r-doing-1', ?1, 'agent', 'running', 'i-doing-1')")
        .run(ids().repo.id);
      const r = await row();
      expect(r).toContain("Working on: Add &lt;b&gt;rye&lt;/b&gt; bread");
      expect(r).not.toContain("<b>rye");
      clean();
    });

    test("a change landed this week reads Finished once, not Last change too", async () => {
      clean();
      seedIssue("i-doing-2", 9002, "pull", "Fix the menu", "closed");
      child.db
        .query("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at) VALUES ('i-doing-2', 'main', 'x', ?1, ?1, ?2)")
        .run("0".repeat(40), new Date(Date.now() - 3 * 86_400_000).toISOString());
      const r = await row();
      expect(r).toContain("Finished");
      expect(r).toContain("3 days ago");
      expect(r).toContain("Fix the menu");
      expect(r).not.toContain("Last change");
      expect(r).not.toContain("client-app-doing");
      clean();
    });

    test("the newest merged pull reads Finished, on that app only, escaped, with its own phase", async () => {
      clean();
      const maria = ids().maria;
      const other = await createRepo(child, maria, { name: "cafe2", owner: "marias" });
      if (!other.ok) throw new Error(JSON.stringify(other.error));
      const none = main(await page(owner));
      expect(none).not.toContain("client-app-finished");
      seedIssue("i-doing-4", 9004, "pull", "Older <i>fix</i>", "closed");
      seedIssue("i-doing-5", 9005, "pull", "Add <b>rye</b> bread", "closed");
      const ins = child.db.query(
        "INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at) VALUES (?1, 'main', 'x', ?2, ?2, ?3)",
      );
      ins.run("i-doing-4", "0".repeat(40), new Date(Date.now() - 90 * 86_400_000).toISOString());
      ins.run("i-doing-5", "0".repeat(40), new Date(Date.now() - 40 * 86_400_000).toISOString());
      const home = main(await page(owner));
      const line = home.match(/client-app-finished[^>]*>([^]*?)<\/span>/)?.[1] ?? "";
      expect(line).toContain("Finished");
      expect(line).toContain("Add &lt;b&gt;rye&lt;/b&gt; bread");
      expect(line).not.toContain("Older");
      for (const word of ["pull", "branch", "commit", "merge", "CI", "repository", "repositories"])
        expect(words(line)).not.toMatch(new RegExp(`\\b${word}`, "i"));
      expect(home.match(/client-app-finished/g)?.length).toBe(1);
      const cafe = home.slice(home.indexOf('href="/marias/cafe2"'));
      expect(cafe.slice(0, cafe.indexOf("</li>"))).not.toContain("Finished");
      const res = await fetch(url("/"), { headers: { cookie: owner } });
      expect(res.headers.get("server-timing") ?? "").toMatch(/\bfinished;/);
      child.db.query("DELETE FROM repo WHERE id = ?1").run(other.value.id);
      clean();
    });

    test("the read is its own doing phase beside apps", async () => {
      const res = await fetch(url("/"), { headers: { cookie: owner } });
      const timing = res.headers.get("server-timing") ?? "";
      expect(timing).toMatch(/\bdoing;/);
      expect(timing).toMatch(/\bapps;/);
    });

    test("the terminal's line for the app carries it too", async () => {
      clean();
      seedIssue("i-doing-3", 9003, "issue", "Add rye bread", "open");
      child.db
        .query("INSERT INTO run (id, repo_id, kind, state, issue_id) VALUES ('r-doing-3', ?1, 'agent', 'running', 'i-doing-3')")
        .run(ids().repo.id);
      const terminal = headlessTerminal(160, 30);
      const { app } = createForgeApp(
        child,
        { sshUsername: "maria", remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user: ids().maria },
        { terminal, exitHooks: false },
      );
      app.start();
      await settleApp(app);
      expect(app.screen.toText()).toContain("Working on: Add rye bread");
      app.stop();
      clean();
    });

    test("the terminal's line for the app says what was finished too", async () => {
      clean();
      seedIssue("i-doing-6", 9006, "pull", "Fix the menu", "closed");
      child.db
        .query("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at) VALUES ('i-doing-6', 'main', 'x', ?1, ?1, ?2)")
        .run("0".repeat(40), new Date(Date.now() - 3 * 86_400_000).toISOString());
      const terminal = headlessTerminal(160, 30);
      const { app } = createForgeApp(
        child,
        { sshUsername: "maria", remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user: ids().maria },
        { terminal, exitHooks: false },
      );
      app.start();
      await settleApp(app);
      const text = app.screen.toText();
      expect(text).toContain("Finished 3 days ago: Fix the menu");
      expect(text).not.toContain("Last change");
      app.stop();
      clean();
    });

    test("titles are cut to 80 characters at a word boundary", () => {
      const long = "word ".repeat(30);
      const cut = cutTitle(long);
      expect(cut.length).toBeLessThanOrEqual(80);
      expect(cut.endsWith("word…")).toBe(true);
      expect(cutTitle("short title")).toBe("short title");
      expect(cutTitle("x".repeat(200))).toBe(`${"x".repeat(79)}…`);
      expect(doingLine(undefined)).toBe("");
    });
  });
});
