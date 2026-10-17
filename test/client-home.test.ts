/**
 * A client's first screen (#1812): signed in through a child forge's claim
 * link, a person sees their apps, one plain line each and whether its agents
 * work or wait; no map, board or settings until asked, and none of the
 * developer's words.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { childDirOf, spawnForge } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { addCrew, createAgentRow, setCrewRole } from "../src/core/agents.ts";
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
    setCrewRole(parent.db, repo.value.id, atlas.value.id, "planner");
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
    expect(home).not.toContain('id="live-apps"');
    for (const gone of ['href="/map"', 'href="/board"', 'href="/audit"', 'href="/settings"'])
      expect(home).not.toContain(gone);
    expect(home).toContain('href="/?all=1"');
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

  test("none of the developer's words appear on it, composer included", async () => {
    const text = words(await page(owner));
    expect(text).toContain("Your apps");
    for (const word of ["pull", "branch", "commit", "merge", "CI", "repository", "repositories"])
      expect(text).not.toMatch(new RegExp(`\\b${word}`, "i"));
  });

  test("asked for, the whole home is still there", async () => {
    const home = await page(owner, "/?all=1");
    expect(home).toContain('id="live-apps"');
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
    app.stop();
  });
});
