import { stylesheetAsset } from "../src/web/asset.ts";
/**
 * The board: a live wall of the crews at work. Signed in, four live
 * regions; a run in flight and a merged pull on it; `?apps=` narrows it;
 * `?wall` is its wall mode, where every old `/big` address lands;
 * anonymous is sent to sign in. Its words are the studio's own.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { forgeNeeds } from "../src/actions/health.ts";
import { changeCapacity } from "../src/actions/capacity.ts";
import { enableApp } from "../src/actions/apps.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { getAppByRepo } from "../src/core/apps.ts";
import { hunt } from "../src/crew/sentinel.ts";
import { recordDecision } from "../src/core/decisions.ts";
import { recordLook } from "../src/core/looks.ts";
import { getPull } from "../src/core/pulls.ts";
import { getRepo, updateRepoSettings, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { submitReview } from "../src/core/reviews.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { boardCss } from "../src/web/pages/board.ts";
import { meter } from "../src/web/ui.ts";
import { withScripts } from "./helpers/page-script.ts";

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

  // Module loggers reach every forge in the process: each test starts from a quiet ledger.
  beforeEach(() => {
    app.signals.errors.clear();
    app.signals.refused.clear();
  });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-board-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, { origin: "seed", trusted: true,
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
    expect(html).toMatch(/id="working"\s+data-live="run\.queued,run\.started,run\.finished"/);
    expect(html).toMatch(
      /id="landed"\s+data-live="pull\.merged,run\.finished"/,
    );
    expect(html).toMatch(/id="decided"\s+data-live="run\.queued,run\.started,run\.finished,pull\.\*"/);
    expect(html).toMatch(/id="today"\s+data-live="run\.queued,run\.started,run\.finished,pull\.merged"/);
    expect(html).toContain("Nobody is working right now.");
    expect(html).toContain("Nothing has shipped yet.");
    expect(html).toContain("Nothing decided yet.");
    // The one app that runs on its own, with its ceiling.
    expect(html).toContain('data-key="app:');
    expect(html).toMatch(/\$0\.00<\/b> of\s+\$20/);
    expect(html).toContain('id="board-live"');
    expect(html).toContain('id="board-clock"');
    expect(await withScripts(servers.url, html)).toContain("new EventSource('/events')");
    expect(await withScripts(servers.url, html)).toContain("requestFullscreen");
    // A wall left open all day fetches its 13 KB of rules once, with the rest
    // of the design, instead of carrying them inline on every reload. The one
    // style element every page carries is the boot style that paints the
    // canvas before the stylesheet arrives (layout.ts, `bootCss`): tiny, and
    // never a rule of the board's own.
    expect(html.match(/<style/g)).toHaveLength(1);
    expect(html).not.toMatch(/<style[^>]*>[^<]*\.board-/);
    expect(html).toContain(
        `<link rel="stylesheet" href="${stylesheetAsset().path}"`,
      );
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
    // In the studio's words (`runWord`): in flight is *working*, queued
    // is *waiting* — the board has no words of its own.
    expect(working).toContain('data-word="working"');
    expect(working).toContain('data-word="waiting"');
    expect(working).not.toContain(">queued</span");
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
      `src="/alice/notes/looks/production/${pull.headOid}/thumb.png?v=`,
    );
    // Decided: kind in words, the answer, how sure, the pick's issue.
    const decided = html.slice(
      html.indexOf('id="decided"'),
      html.indexOf('id="today"'),
    );
    expect(decided).toContain("ship or show");
    expect(decided).toContain('value="82"');
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

  test("review on an app's card: pulls awaiting it, the wait for a verdict, verdicts per reviewer", async () => {
    const scout = getUserByName(app.db, "scout")!;
    const branch = await commitToBranch(app, alice, notes, {
      branch: "feature/review-me",
      base: "main",
      message: "Review me",
      files: [{ path: "REVIEW.md", content: "review me\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, scout, notes, {
      title: "Review me",
      body: "",
      baseBranch: "main",
      headBranch: "feature/review-me",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const check = createRun(app.db, {
      repoId: notes.id,
      kind: "check",
      issueId: opened.value.id,
      env: `pull-${opened.value.number}`,
      commitOid: opened.value.headOid,
      reason: "pull",
    });
    claimRun(app.db, check.id);
    finishRun(app.db, check.id, { state: "ok", summary: "check passed" });
    expect(await (await get("/board")).text()).toContain("1 awaiting review");

    const juniper = await createAgent(app, alice, { username: "juniper" });
    if (!juniper.ok) throw new Error(String(juniper.error));
    submitReview(app.db, {
      issueId: opened.value.id,
      authorId: juniper.value.user.id,
      state: "changes_requested",
      commitOid: opened.value.headOid,
    });
    const html = await (await get("/board")).text();
    expect(html).not.toContain("awaiting review");
    expect(html).toMatch(/\d+m from green to a verdict · juniper 1/);
  });

  test("the home's shelf opens the board", async () => {
    const home = await (
      await get("/", { cookie: `${cookie}; forge_mode=studio` })
    ).text();
    expect(home).toContain('href="/board"');
    expect(home).toContain("Board");
  });

  test("built from the design system: no page-local class but §5's board, one column under 1100px", async () => {
    const html = await (await get("/board")).text();
    const body = html.slice(html.indexOf('<div class="board"'), html.indexOf("<script"));
    const classes = new Set(
      [...body.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1]!.split(/\s+/)),
    );
    expect([...classes].filter((c) => c.startsWith("board")).sort()).toEqual([
      "board",
      "board-grid",
      "board-region",
    ]);
    // The four regions sit side by side only on a monitor; a phone reads one
    // column, each region after the last.
    const sheet = boardCss.slice(0, boardCss.indexOf("@media (min-width: 1100px)"));
    expect(sheet).not.toContain("grid-template-columns");
    expect(boardCss.slice(sheet.length)).toContain(".board-grid { grid-template-columns");
  });

  test("?wall is the wall mode: the same live regions, marked for the far screen", async () => {
    const plain = await (await get("/board")).text();
    expect(plain).not.toContain("data-wall");
    const res = await get("/board?apps=alice/notes&wall");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/<div class="board"\s+data-wall="">/);
    expect(html).toMatch(/id="working"\s+data-live="run\.queued,run\.started,run\.finished"/);
    expect(html).toMatch(/id="board-scope"\s*>notes</);
  });

  // The big view's every address, each its own test: all land on the wall mode.
  const oldRoutes: [string, string][] = [
    ["/big", "/board?wall"],
    ["/big?view=board", "/board?wall"],
    ["/big?view=map", "/board?wall"],
    ["/big?app=alice/notes", "/board?apps=alice%2Fnotes&wall"],
    ["/big?app=alice%2Fnotes&list=runs", "/board?apps=alice%2Fnotes&wall"],
    ["/big?app=alice/notes&list=issues", "/board?apps=alice%2Fnotes&wall"],
    ["/big?app=alice/notes&list=pulls", "/board?apps=alice%2Fnotes&wall"],
    ["/big?app=alice/notes&list=map", "/board?apps=alice%2Fnotes&wall"],
    ["/big?run=0123456789abcdef", "/board?wall"],
    // An address that was never an app keeps no scope.
    ["/big?app=../../etc", "/board?wall"],
    ["/big?app=%22%3E%3Cscript%3E", "/board?wall"],
  ];
  for (const [from, to] of oldRoutes)
    test(`${from} lands on ${to}`, async () => {
      const res = await get(from);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(to);
      const landed = await get(to);
      expect(landed.status).toBe(200);
      expect(await landed.text()).toContain("data-wall");
    });

  test("anonymous at /big reaches the sign-in by way of the wall", async () => {
    const res = await fetch(`${base}/big?app=alice/notes`, {
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/board?apps=alice%2Fnotes&wall");
    const next = await fetch(`${base}/board?wall`, { redirect: "manual" });
    expect(next.headers.get("location")).toMatch(/^\/signin\?next=/);
  });
});

describe("the board speaks the studio's words", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let cookie: string;

  const board = async () =>
    (
      await fetch(`${servers.url}/board`, {
        headers: { cookie },
        redirect: "manual",
      })
    ).text();
  const between = (html: string, from: string, to: string) =>
    html.slice(html.indexOf(`id="${from}"`), html.indexOf(`id="${to}"`));

  /** Production at this commit, as the runtime would report it — the same
   * stand-in `test/studio.test.ts` uses for its words. */
  const serving = (appId: string, commitOid: string): void => {
    const envs = (runtime as unknown as { envs: Map<string, unknown> }).envs;
    const record = { id: appId };
    envs.set(`${appId}/production`, {
      app: record,
      env: "production",
      chain: Promise.resolve(),
      restarts: [],
      live: {
        commitOid,
        handle: { port: 4321 },
        runId: "fake",
        since: new Date().toISOString(),
        manifest: { tty: null },
      },
    });
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-board-words-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    // Never started: nothing deploys on its own, so production stands
    // exactly where `serving` puts it.
    runtime = new AppsRuntime(app, {
      domain: "board-words.test",
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 1,
    });
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    cookie = (
      (
        await fetch(`${servers.url}/signin`, {
          method: "POST",
          body: new URLSearchParams({
            username: "alice",
            password: "a-good-passphrase",
          }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a merge production has not served is not shipped; a run in flight is working; the regions are as they were", async () => {
    const alice = getUserByName(app.db, "alice")!;
    const made = await createRepo(app, alice, { name: "notes" });
    if (!made.ok) throw new Error(String(made.error));
    const repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "start\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, alice, repo, { slug: "notes" });
    if (!enabled.ok) throw new Error(String(enabled.error));
    const record = getAppByRepo(app.db, repo.id)!;

    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/fast",
      base: "main",
      message: "Faster",
      files: [{ path: "FAST.md", content: "fast\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "Faster notes",
      body: "",
      baseBranch: "main",
      headBranch: "feature/fast",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    recordDecision(app.db, {
      kind: "land",
      repoId: repo.id,
      issueId: opened.value.id,
      state: {},
      answer: "ship",
      p: 0.9,
      by: "typesafe",
      ms: 1,
    });
    const merged = await mergePull(app, alice, repo, opened.value, "squash");
    if (!merged.ok) throw new Error(JSON.stringify(merged.error));
    const pull = getPull(app.db, repo.id, opened.value.number)!;
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      reason: "feedback",
      summary: "on the list",
    });
    claimRun(app.db, run.id);

    // Production is still on the commit before the merge.
    serving(record.id, seeded.value.commitOid);
    const before = await board();
    const landed = between(before, "landed", "decided");
    expect(landed).toContain("Faster notes");
    expect(landed).toMatch(/data-variant="secondary"\s+data-word="waiting"/);
    expect(landed).not.toContain('data-word="shipped"');
    // The ledger wrote *shipped* at the merge; the board does not repeat it.
    const decided = between(before, "decided", "today");
    expect(decided).toContain("ship or show");
    expect(decided).toContain('data-word="waiting"');
    expect(decided).not.toContain(">shipped<");
    expect(decided).not.toContain("data-outcome");
    const working = between(before, "working", "landed");
    expect(working).toMatch(
      /data-variant="accent"\s+data-word="working"/,
    );
    expect(working).toContain("on what you said");
    // The regions themselves are as they were.
    expect(before).toMatch(
      /id="working"\s+data-live="run\.queued,run\.started,run\.finished"/,
    );
    expect(before).toMatch(
      /id="landed"\s+data-live="pull\.merged,run\.finished"/,
    );
    expect(before).toMatch(
      /id="decided"\s+data-live="run\.queued,run\.started,run\.finished,pull\.\*"/,
    );
    expect(before).toMatch(
      /id="today"\s+data-live="run\.queued,run\.started,run\.finished,pull\.merged"/,
    );

    // Production caught up with the merge: shipped, in both lists.
    serving(record.id, pull.mergedOid!);
    const after = await board();
    expect(between(after, "landed", "decided")).toMatch(
      /data-variant="success"\s+data-word="shipped"/,
    );
    expect(between(after, "decided", "today")).toContain(
      'data-word="shipped"',
    );
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

  // Module loggers reach every forge in the process: each test starts from a quiet ledger.
  beforeEach(() => {
    app.signals.errors.clear();
    app.signals.refused.clear();
  });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-board-strip-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    for (const [username, adminIfFirst] of [
      ["root", true],
      ["bob", false],
    ] as const) {
      const u = await createUser(app.db, { origin: "seed", trusted: true,
        username,
        // Fixtures may name an account after a reserved word on purpose.
        allowReserved: true,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst,
      });
      if (!u.ok) throw new Error(u.error);
      if (username === "root") admin = u.value;
      cookies[username] = await signIn(username);
    }
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an admin reads All fine; a stuck run becomes a linked sentence; a non-admin sees nothing", async () => {
    const fine = await board("root");
    expect(fine).toMatch(/id="notes"\s+data-live="[^"]*app\.\*"\s+data-ok="yes"/);
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
    expect(stuck).toContain(`Run ${run.id} is stuck: it has not moved 2020-01-01.`);
    expect(stuck).toContain(`href="/root/stuck/runs/${run.id}"`);

    const other = await board("bob");
    expect(other).not.toContain("data-ok");
    expect(other).not.toContain("All fine");
    expect(other).not.toContain("stuck.");
  });

  test("the home lists the week's flaky tests, to an admin only", async () => {
    expect(await board("root")).not.toContain("Flaky this week");
    const made = await createRepo(app, admin, { name: "flaky" });
    if (!made.ok) throw new Error(String(made.error));
    app.db
      .query("INSERT INTO check_flake (id, repo_id, run_id, commit_oid, test, file) VALUES ('f1', ?1, 'r1', 'abc1234', 'grp > flaky', 't/a.test.ts')")
      .run(made.value.id);
    expect(await board("root")).toContain("Flaky this week: grp &gt; flaky ×1 (root/flaky)");
    expect(await board("bob")).not.toContain("Flaky this week");
    app.db.query("DELETE FROM check_flake").run();
  });

  test("the home says the lane when checks are queued, to an admin only", async () => {
    app.db.query("UPDATE run SET state = 'cancelled' WHERE state IN ('queued','running')").run();
    const idle = await board("root");
    expect(idle).not.toContain("Lane:");
    const made = await createRepo(app, admin, { name: "laned" });
    if (!made.ok) throw new Error(String(made.error));
    for (let i = 0; i < 3; i++) createRun(app.db, { repoId: made.value.id, kind: "check" });
    const busy = await board("root");
    expect(busy).toContain("Lane: 3 checks queued");
    expect(await board("bob")).not.toContain("Lane:");
    app.db.query("UPDATE run SET state = 'cancelled' WHERE state IN ('queued','running')").run();
  });

  test("a setting that is not the default is no incident: the strip stays fine and the cards render", async () => {
    const made = await createRepo(app, admin, { name: "calm" });
    if (!made.ok) throw new Error(String(made.error));
    const enabled = await enableApp(app, admin, made.value, { slug: "calm" });
    if (!enabled.ok) throw new Error(String(enabled.error));
    claimRun(app.db, createRun(app.db, { repoId: made.value.id, kind: "agent" }).id);
    // Clear the stuck run the first test left behind.
    app.db.query("UPDATE run SET state = 'failed' WHERE heartbeat_at = ?1").run("2020-01-01T00:00:00.000Z");
    expect(changeCapacity(app, admin, "cells.egress", "report").ok).toBe(true);
    try {
      const text = await board("root");
      expect(text).toContain("All fine");
      expect(text).not.toContain("data-need");
      expect(text).not.toContain("error-note");
      expect(text).toContain('data-key="run:');
    } finally {
      changeCapacity(app, admin, "cells.egress", "enforce");
    }
  });

  test("a blocked rollout shows in the status line, escaped, for an admin only", async () => {
    const guard = mkdtempSync(join(tmpdir(), "forge-board-guard-"));
    process.env["FORGE_GUARD_DIR"] = guard;
    try {
      writeFileSync(
        join(guard, "status.json"),
        JSON.stringify({ incidents: { stuck: "quota refused <i>8Gi</i>" } }),
      );
      writeFileSync(join(guard, "checkedAt"), new Date().toISOString());
      const blocked = await board("root");
      expect(blocked).toContain("needs you: forge stuck: quota refused &lt;i&gt;8Gi&lt;/i&gt;");
      expect(blocked).not.toContain("<i>8Gi</i>");
      // One line, said once, and the board beneath it still renders.
      expect(blocked.match(/<(?:a|span) data-need/g)?.length).toBe(1);
      expect(blocked).not.toContain("rollout blocked");
      expect(blocked).toContain('data-key="run:');
      expect(await board("bob")).not.toContain("quota refused");
    } finally {
      delete process.env["FORGE_GUARD_DIR"];
      rmSync(guard, { recursive: true, force: true });
    }
  });

  test("a held incident reads needs you: forge held: …, and no incident leaves All fine", async () => {
    const guard = mkdtempSync(join(tmpdir(), "forge-board-guard-"));
    process.env["FORGE_GUARD_DIR"] = guard;
    try {
      writeFileSync(join(guard, "status.json"), JSON.stringify({ incidents: { held: "preflight refused 1.2" } }));
      writeFileSync(join(guard, "checkedAt"), new Date().toISOString());
      const held = await board("root");
      expect(held).toContain("needs you: forge held: preflight refused 1.2");
      expect(held).toMatch(/data-ok="no"/);
      expect(held).not.toContain("All fine");
      expect(held.split("held: preflight refused 1.2").length - 1).toBe(1);
      expect(forgeNeeds(app, admin)).toContain("held: preflight refused 1.2");
      writeFileSync(join(guard, "status.json"), JSON.stringify({ incidents: {} }));
      expect(await board("root")).toContain("All fine");
    } finally {
      delete process.env["FORGE_GUARD_DIR"];
      rmSync(guard, { recursive: true, force: true });
    }
  });

  test("eight notes fold into one closed line; the panels come first and nothing else sits above them", async () => {
    const guard = mkdtempSync(join(tmpdir(), "forge-board-guard-"));
    process.env["FORGE_GUARD_DIR"] = guard;
    try {
      const incidents = Object.fromEntries(
        Array.from({ length: 8 }, (_, i) => [`cause${i}`, `trouble ${i} <raw words>`]),
      );
      writeFileSync(join(guard, "status.json"), JSON.stringify({ incidents }));
      writeFileSync(join(guard, "checkedAt"), new Date().toISOString());
      const text = await board("root");
      const top = text.slice(text.indexOf('<div class="board"'), text.indexOf('class="board-grid"'));
      // Closed by default; one summary, counted.
      expect(top).toMatch(/<details id="notes-list" class="disclosure">/);
      expect(top).not.toMatch(/<details[^>]*\sopen/);
      expect(top).toMatch(/<summary[^>]*>\s*\d+ notes · <span[^>]*>\s*<span\s+class="dot"\s+data-tone="attn"\s*><\/span> \d+ need you<\/span>\s*<\/summary>/);
      expect(top.match(/<li>/g)?.length).toBeGreaterThanOrEqual(8);
      expect(top).toContain("trouble 7 &lt;raw words&gt;");
      // The title and the notes are all that precede the panels.
      expect(top).not.toContain('id="returns-line"');
      expect(top).not.toContain('id="asks-measure"');
      expect(top).not.toContain('id="windows"');
      expect(text.indexOf('id="notes"')).toBeLessThan(text.indexOf('id="working"'));
      // Notes wrap rather than clip, and the summary is a real touch target.
      expect(boardCss).not.toMatch(/#notes li[^\n]*nowrap/);
      expect(boardCss).not.toMatch(/#notes summary \{/);
      // No stored state: the first paint is the only paint.
      expect(text).not.toContain("localStorage");
    } finally {
      delete process.env["FORGE_GUARD_DIR"];
      rmSync(guard, { recursive: true, force: true });
    }
  });

  test("the sentinel's line is the admin's alone, and absent before the first hunt", async () => {
    expect(await board("root")).not.toContain("sentinel");

    // A check queued two hours with nothing running: a held slot, a finding.
    const stuck = getRepo(app.db, "root", "stuck")!;
    const queued = createRun(app.db, { repoId: stuck.id, kind: "check" });
    app.db
      .query("UPDATE run SET created_at = ?2 WHERE id = ?1")
      .run(queued.id, new Date(Date.now() - 2 * 3_600_000).toISOString());
    process.env["FORGE_SENTINEL_REPO"] = "root/stuck";
    try {
      expect(hunt(app, "root/stuck").filed).toBeGreaterThan(0);
      const seen = await board("root");
      expect(seen).toMatch(/<a data-need id="sentinel" href="\/root\/stuck\/issues">[\s\S]*?The sentinel has \d+ open findings?<\/a>/);
      // A need, so it wears the attention dot, never the fine one.
      expect(seen).toMatch(/id="sentinel"[^>]*>\s*<span\s+class="dot"\s+data-tone="attn"/);
      expect(await board("bob")).not.toMatch(/sentinel/i);
      const guest = await (await fetch(`${servers.url}/board`)).text();
      expect(guest).not.toMatch(/sentinel/i);
    } finally {
      delete process.env["FORGE_SENTINEL_REPO"];
      app.db.query("DELETE FROM run WHERE id = ?1").run(queued.id);
    }
  });
});

describe("meter", () => {
  test("a whole percentage between 0 and 100, said in words, attn only when asked", () => {
    expect(meter(82.4, "82% sure").text).toMatch(/value="82"[\s\S]*aria-label="82% sure"/);
    expect(meter(140, "over").text).toContain('value="100"');
    expect(meter(-3, "under").text).toContain('value="0"');
    expect(meter(50, "half").text).not.toContain("data-tone");
    expect(meter(100, "at the ceiling", "attn").text).toContain('data-tone="attn"');
    expect(meter(1, '<b>"x"</b>').text).not.toContain("<b>");
  });
});
