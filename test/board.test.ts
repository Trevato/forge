/**
 * The board: a live wall of the crews at work. Signed in, four live
 * regions; a run in flight and a merged pull on it; `?apps=` narrows it;
 * anonymous is sent to sign in.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { enableApp } from "../src/actions/apps.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { getAppByRepo } from "../src/core/apps.ts";
import { recordDecision } from "../src/core/decisions.ts";
import { recordLook } from "../src/core/looks.ts";
import { getPull } from "../src/core/pulls.ts";
import { updateRepoSettings, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun } from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("the board", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let notes: Repo;
  let shop: Repo;
  let cookie: string;

  const get = (path: string, extra: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      headers: { cookie, ...extra },
      redirect: "manual",
    });

  /** A repository that is an app, with one file the runtime could start. */
  async function makeApp(name: string): Promise<Repo> {
    const made = await createRepo(app, alice, { name, visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    const seeded = await commitToBranch(app, alice, made.value, {
      message: "Start",
      files: [
        {
          path: "package.json",
          content: `{"name":"${name}","scripts":{"start":"bun run server.ts"}}\n`,
        },
        {
          path: "server.ts",
          content:
            "Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('ok') });\n",
        },
      ],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, alice, made.value, { slug: name });
    if (!enabled.ok) throw new Error(String(enabled.error));
    return made.value;
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-board-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, {
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    cookie = (
      (
        await fetch(`${base}/signin`, {
          method: "POST",
          body: new URLSearchParams({
            username: "alice",
            password: "a-good-passphrase",
          }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
    notes = await makeApp("notes");
    shop = await makeApp("shop");
    const scout = await createAgent(app, alice, { username: "scout" });
    if (!scout.ok) throw new Error(String(scout.error));
    expect(addToCrew(app, alice, notes, "scout").ok).toBe(true);
    expect(addToCrew(app, alice, shop, "scout").ok).toBe(true);
    notes = updateRepoSettings(app.db, notes, {
      autonomy: "autonomous",
      autonomyDirection: "Notes that load fast.",
      autonomyCeilingUsd: 20,
      autonomySlots: 2,
      autonomyBy: alice.id,
    });
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("anonymous is sent to sign in, and comes back to the board", async () => {
    const res = await fetch(`${base}/board`, { redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/signin?next=%2Fboard");
  });

  test("signed in: a bare page, four live regions, dark by default", async () => {
    const res = await get("/board");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<html lang="en" data-theme="dark">');
    expect(html).not.toContain('class="topbar"');
    expect(html).not.toContain('class="foot"');
    expect(html).toMatch(/<main\s+class="bare"\s+id="main"\s*>/);
    expect(html).toMatch(/id="working"\s+data-live="run\.\*"/);
    expect(html).toMatch(
      /id="landed"\s+data-live="pull\.merged,run\.finished"/,
    );
    expect(html).toMatch(/id="decided"\s+data-live="run\.\*,pull\.\*"/);
    expect(html).toMatch(/id="today"\s+data-live="run\.\*,pull\.merged"/);
    expect(html).toContain("Nobody is working right now.");
    expect(html).toContain("Nothing has shipped yet.");
    expect(html).toContain("Nothing decided yet.");
    // The one app that runs on its own, with its ceiling.
    expect(html).toContain('class="board-card board-app"');
    expect(html).toMatch(/\$0\.00<\/b> of\s+\$20/);
    expect(html).toContain('id="board-live"');
    expect(html).toContain('id="board-clock"');
    expect(html).toContain("new EventSource('/events')");
    expect(html).toContain("requestFullscreen");
    // A wall left open all day fetches its 13 KB of rules once, with the rest
    // of the design, instead of carrying them inline on every reload.
    expect(html).not.toContain("<style");
    expect(html).toContain('<link rel="stylesheet" href="/assets/forge.css"');
    // A viewer who chose a theme keeps it.
    const paper = await (
      await get("/board", { cookie: `${cookie}; forge_theme=paper` })
    ).text();
    expect(paper).toContain('data-theme="paper"');
  });

  test("a run in flight, a merged pull and a decision are on it; ?apps= narrows", async () => {
    const scout = getUserByName(app.db, "scout")!;
    const told = openIssue(app, alice, notes, {
      title: "Make the notes page load in under a second",
    });
    if (!told.ok) throw new Error(String(told.error));
    const queued = createRun(app.db, {
      repoId: notes.id,
      kind: "agent",
      issueId: told.value.id,
      actorId: scout.id,
      reason: "assigned",
    });
    const running = createRun(app.db, {
      repoId: shop.id,
      kind: "agent",
      actorId: scout.id,
      reason: "feedback",
      summary: "on the cart",
    });
    claimRun(app.db, running.id);

    const branch = await commitToBranch(app, alice, notes, {
      branch: "feature/fast",
      base: "main",
      message: "Faster",
      files: [{ path: "FAST.md", content: "fast\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, scout, notes, {
      title: "Faster notes",
      body: "",
      baseBranch: "main",
      headBranch: "feature/fast",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const merged = await mergePull(app, alice, notes, opened.value, "squash");
    if (!merged.ok) throw new Error(JSON.stringify(merged.error));
    const pull = getPull(app.db, notes.id, opened.value.number)!;
    // A production thumb of the app that just landed: the board's landed
    // row leads with it, not with the full phone shot.
    const notesApp = getAppByRepo(app.db, notes.id)!;
    recordLook(app.db, {
      appId: notesApp.id,
      env: "production",
      commitOid: pull.headOid,
      kind: "thumb",
      path: "looks/does-not-matter.png",
    });
    recordDecision(app.db, {
      kind: "land",
      repoId: notes.id,
      issueId: pull.id,
      state: { head: pull.headOid },
      answer: "ship",
      p: 0.82,
      by: "typesafe",
      ms: 40,
    });
    recordDecision(app.db, {
      kind: "next",
      repoId: notes.id,
      issueId: told.value.id,
      state: {},
      answer: String(told.value.number),
      p: 1,
      by: "rule",
      ms: 0,
    });

    const html = await (await get("/board")).text();
    // Working: the running run first, then the queued one, each with its clock.
    const working = html.slice(
      html.indexOf('id="working"'),
      html.indexOf('id="landed"'),
    );
    expect(working).toContain('data-state="working"');
    expect(working).toContain('data-state="queued"');
    expect(working.indexOf("on the cart")).toBeLessThan(
      working.indexOf("Make the notes page load"),
    );
    expect(working).toContain(`data-started="${queued.createdAt}"`);
    expect(working).toContain(`/alice/shop/runs/${running.id}`);
    expect(working).toContain("on what you said");
    expect(working).toContain("building it");
    // Landed: the merge, with who and the app.
    const landed = html.slice(
      html.indexOf('id="landed"'),
      html.indexOf('id="decided"'),
    );
    expect(landed).toContain("Faster notes");
    expect(landed).toContain("notes · scout");
    expect(landed).toContain(`/alice/notes/pulls/${pull.number}`);
    expect(landed).toContain(
      `src="/alice/notes/looks/production/${pull.headOid}/thumb.png"`,
    );
    // Decided: kind in words, the answer, how sure, the pick's issue.
    const decided = html.slice(
      html.indexOf('id="decided"'),
      html.indexOf('id="today"'),
    );
    expect(decided).toContain("ship or show");
    expect(decided).toContain('data-w="82"');
    expect(decided).toContain("by typesafe");
    expect(decided).toContain("next issue");
    expect(decided).toContain(`#${told.value.number}`);
    expect(decided).toContain("by the rule");
    // Today: one run today and one shipped for notes.
    const today = html.slice(html.indexOf('id="today"'));
    expect(today).toContain("<b>1</b> run</span>");
    expect(today).toContain("<b>1</b> shipped");

    // Narrowed to shop: its run, and none of notes.
    const narrowed = await (await get("/board?apps=shop")).text();
    expect(narrowed).toContain("on the cart");
    expect(narrowed).not.toContain("Make the notes page load");
    expect(narrowed).not.toContain("Faster notes");
    expect(narrowed).toContain("No app runs on its own yet.");
    const byOwner = await (await get("/board?apps=alice/notes")).text();
    expect(byOwner).toContain("Make the notes page load");
    expect(byOwner).not.toContain("on the cart");
  });

  test("the home's shelf opens the board", async () => {
    const home = await (
      await get("/", { cookie: `${cookie}; forge_mode=studio` })
    ).text();
    expect(home).toContain('href="/board"');
    expect(home).toContain("Board");
  });
});

describe("the board's forge strip", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let admin: User;
  let cookies: Record<string, string> = {};

  async function signIn(name: string): Promise<string> {
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({
        username: name,
        password: "a-good-passphrase",
      }),
      redirect: "manual",
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  }
  const board = async (who: string) =>
    (
      await fetch(`${servers.url}/board`, {
        headers: { cookie: cookies[who]! },
      })
    ).text();

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-board-strip-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    for (const [username, adminIfFirst] of [
      ["root", true],
      ["bob", false],
    ] as const) {
      const u = await createUser(app.db, {
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst,
      });
      if (!u.ok) throw new Error(u.error);
      if (username === "root") admin = u.value;
      cookies[username] = await signIn(username);
    }
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an admin reads All fine; a stuck run becomes a linked sentence; a non-admin sees nothing", async () => {
    const fine = await board("root");
    expect(fine).toMatch(/id="forge"\s+data-live="run\.\*,app\.\*"/);
    expect(fine).toContain("All fine");

    const made = await createRepo(app, admin, { name: "stuck" });
    if (!made.ok) throw new Error(String(made.error));
    const run = createRun(app.db, { repoId: made.value.id, kind: "agent" });
    claimRun(app.db, run.id);
    // Its last heartbeat is long past: the lease has lapsed.
    app.db
      .query("UPDATE run SET heartbeat_at = ?1 WHERE id = ?2")
      .run("2020-01-01T00:00:00.000Z", run.id);
    const stuck = await board("root");
    expect(stuck).not.toContain("All fine");
    expect(stuck).toContain("1 run is stuck.");
    expect(stuck).toContain(`href="/root/stuck/runs/${run.id}"`);

    const other = await board("bob");
    expect(other).not.toContain('id="forge"');
    expect(other).not.toContain("All fine");
    expect(other).not.toContain("stuck.");
  });
});
