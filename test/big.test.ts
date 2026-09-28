/**
 * The big view: one keyboard-first frame over the whole forge. Anonymous
 * is sent to sign in; every view renders the shell — header, panes,
 * footer — with live regions; the app view lists a run in flight and an
 * ask with its keys; the command line's targets are real pages; and the
 * sheet lists every key the footer shows. The pure model is tested on
 * its own: where a step lands, what a command means.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { enableApp } from "../src/actions/apps.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { updateRepoSettings, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import {
  backUrl,
  bigUrl,
  COMMANDS,
  findApp,
  footKeysFor,
  halfPage,
  keysFor,
  moveIndex,
  nextPane,
  parseCommand,
} from "../src/web/big-model.ts";

// ---- the model ----

describe("the big view's model", () => {
  test("a step lands where vim would: first row on the way down, last on the way up, never past an end", () => {
    expect(moveIndex(0, -1, 1)).toBe(-1);
    expect(moveIndex(3, -1, 1)).toBe(0);
    expect(moveIndex(3, -1, -1)).toBe(2);
    expect(moveIndex(3, 0, 1)).toBe(1);
    expect(moveIndex(3, 2, 1)).toBe(2);
    expect(moveIndex(3, 0, -1)).toBe(0);
    expect(moveIndex(10, 2, 5)).toBe(7);
    expect(moveIndex(10, 8, 5)).toBe(9);
    expect(halfPage(9)).toBe(4);
    expect(halfPage(1)).toBe(1);
  });

  test("panes wrap both ways", () => {
    expect(nextPane(4, 3, 1)).toBe(0);
    expect(nextPane(4, 0, -1)).toBe(3);
    expect(nextPane(4, -1, 1)).toBe(1);
    expect(nextPane(0, 0, 1)).toBe(-1);
  });

  test("addresses and their parents", () => {
    expect(bigUrl({})).toBe("/big");
    expect(bigUrl({ app: "alice/notes" })).toBe("/big?app=alice%2Fnotes");
    expect(bigUrl({ app: "alice/notes", list: "runs" })).toBe(
      "/big?app=alice%2Fnotes&list=runs",
    );
    expect(bigUrl({ run: "r1" })).toBe("/big?run=r1");
    expect(bigUrl({ view: "board" })).toBe("/big?view=board");
    expect(backUrl({ app: "alice/notes", list: "runs" })).toBe(
      "/big?app=alice%2Fnotes",
    );
    expect(backUrl({ app: "alice/notes" })).toBe("/big");
    expect(backUrl({ run: "r1" }, "alice/notes")).toBe(
      "/big?app=alice%2Fnotes",
    );
    expect(backUrl({ view: "map" })).toBe("/big");
  });

  test("a command means one thing, or says why not", () => {
    const apps = ["alice/notes", "alice/shop", "bob/tempo"];
    expect(findApp("tempo", apps)).toBe("bob/tempo");
    expect(findApp("Alice/Shop", apps)).toBe("alice/shop");
    expect(findApp("no", apps)).toBe("alice/notes");
    expect(findApp("zz", apps)).toBeUndefined();
    const here = { apps };
    expect(parseCommand("app tempo", here)).toEqual({
      kind: "go",
      url: "/big?app=bob%2Ftempo",
    });
    expect(parseCommand(":tempo", here)).toEqual({
      kind: "go",
      url: "/big?app=bob%2Ftempo",
    });
    expect(parseCommand("map", here)).toEqual({
      kind: "go",
      url: "/big?view=map",
    });
    expect(parseCommand("map", { ...here, app: "alice/shop" })).toEqual({
      kind: "go",
      url: "/big?app=alice%2Fshop&list=map",
    });
    expect(parseCommand("runs", here)).toEqual({
      kind: "error",
      message: "open an app first, then :runs",
    });
    expect(parseCommand("pulls", { ...here, app: "alice/shop" })).toEqual({
      kind: "go",
      url: "/big?app=alice%2Fshop&list=pulls",
    });
    expect(parseCommand("app", here)).toEqual({
      kind: "error",
      message: "app which?",
    });
    expect(parseCommand("app nothing", here).kind).toBe("error");
    expect(parseCommand("help", here)).toEqual({ kind: "help" });
    expect(parseCommand("q", here)).toEqual({ kind: "go", url: "/" });
    expect(parseCommand("q", { ...here, app: "alice/shop" })).toEqual({
      kind: "go",
      url: "/alice/shop",
    });
    expect(parseCommand("   ", here)).toEqual({ kind: "none" });
    expect(parseCommand("frobnicate", here).kind).toBe("error");
  });

  test("the footer is a subset of the sheet, for every view", () => {
    for (const view of [
      "home",
      "app",
      "run",
      "board",
      "map",
      "list",
    ] as const) {
      const sheet = new Set(keysFor(view).map((k) => k.keys.join(" ")));
      for (const k of footKeysFor(view))
        expect(sheet.has(k.keys.join(" "))).toBe(true);
    }
  });
});

// ---- the pages ----

describe("the big view", () => {
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

  /** The text of every `<kbd>` inside the element with this id. */
  function kbdsIn(html: string, id: string): Set<string> {
    const start = html.indexOf(`id="${id}"`);
    const open = html.lastIndexOf("<", start);
    const tag = html.slice(open + 1, html.indexOf(" ", open));
    const close = html.indexOf(`</${tag}>`, start);
    const slice = html.slice(start, close);
    return new Set(
      [...slice.matchAll(/<kbd[^>]*>([^<]*)<\/kbd>/g)].map((m) => m[1]!),
    );
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-big-"));
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
      autonomyDirection: "Notes that load fast.\nAnd stay small.",
      autonomyCeilingUsd: 20,
      autonomySlots: 2,
      autonomyBy: alice.id,
    });
    shop = updateRepoSettings(app.db, shop, {
      autonomy: "assisted",
      autonomyDirection: "Sell one real thing.",
      autonomyCeilingUsd: 10,
      autonomySlots: 1,
      autonomyBy: alice.id,
    });
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("anonymous is sent to sign in, and comes back here", async () => {
    const res = await fetch(`${base}/big?app=alice%2Fnotes`, {
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "/signin?next=%2Fbig%3Fapp%3Dalice%252Fnotes",
    );
  });

  test("home: the shell, two live panes, every app as a row, the focused one at a glance", async () => {
    const res = await get("/big");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<html lang="en" data-theme="dark">');
    expect(html).not.toContain('class="topbar"');
    expect(html).toMatch(/<main\s+class="bare"\s+id="main"\s*>/);
    expect(html).toContain('id="big"');
    expect(html).toContain('data-view="home"');
    expect(html).toContain('data-apps="alice/shop alice/notes"');
    expect(html).toContain('<header class="big-top">');
    expect(html).toContain('id="big-clock"');
    expect(html).toContain('id="big-live"');
    expect(html).toContain('<footer class="big-foot" id="big-foot">');
    expect(html).toContain('id="big-line"');
    expect(html).toContain('id="big-help"');
    expect(html).toMatch(
      /id="big-apps"\s+data-live="run\.\*,pull\.\*,issue\.\*,check\.\*"/,
    );
    expect(html).toMatch(
      /id="big-glance"\s+data-live="run\.\*,pull\.\*,issue\.\*,check\.\*"/,
    );
    // The rows: name, autonomy word, working, asks, spend against the ceiling.
    expect(html).toContain('data-key="app:alice/notes"');
    expect(html).toContain('data-href="/big?app=alice%2Fnotes"');
    expect(html).toContain('data-say="/alice/notes/tell"');
    expect(html).toContain('data-word="autonomous"');
    expect(html).toContain('data-word="assisted"');
    expect(html).toMatch(/\$0\.00\s*\/\s*\$20/);
    // The glance: the direction's first line only, and its own lists.
    expect(html).toContain('data-for="app:alice/notes"');
    expect(html).toContain("Notes that load fast.");
    expect(html).not.toContain("And stay small.");
    expect(html).toContain("Nobody is working here right now.");
    expect(html).toContain("new EventSource('/events')");
    // A viewer who chose a theme keeps it.
    const paper = await (
      await get("/big", { cookie: `${cookie}; forge_theme=paper` })
    ).text();
    expect(paper).toContain('data-theme="paper"');
  });

  test("app: a run in flight with its clock and stop key, the map, landed", async () => {
    const scout = getUserByName(app.db, "scout")!;
    const told = openIssue(app, alice, shop, {
      title: "Checkout keeps the total steady",
    });
    if (!told.ok) throw new Error(String(told.error));
    const running = createRun(app.db, {
      repoId: shop.id,
      kind: "agent",
      issueId: told.value.id,
      actorId: scout.id,
      reason: "assigned",
    });
    claimRun(app.db, running.id);
    // A green pull the crew opened: the shop is assisted, so it asks.
    const branch = await commitToBranch(app, alice, shop, {
      branch: "crew/wrap",
      base: "main",
      message: "Gift wrap",
      files: [{ path: "WRAP.md", content: "wrap\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, scout, shop, {
      title: "Gift wrap as a line item",
      body: "",
      baseBranch: "main",
      headBranch: "crew/wrap",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    const check = createRun(app.db, {
      repoId: shop.id,
      kind: "check",
      issueId: pull.id,
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
      reason: "pull",
    });
    claimRun(app.db, check.id);
    finishRun(app.db, check.id, { state: "ok", summary: "check passed" });

    const html = await (await get("/big?app=alice%2Fshop")).text();
    expect(html).toContain('data-view="app"');
    expect(html).toContain('data-here="alice/shop"');
    expect(html).toContain('data-say="/alice/shop/tell"');
    expect(html).toMatch(
      /id="big-working"\s+data-live="run\.\*"\s+data-live-repo="alice\/shop"/,
    );
    expect(html).toMatch(
      /id="big-map"\s+data-live="run\.\*,issue\.\*,pull\.\*"/,
    );
    expect(html).toMatch(
      /id="big-landed"\s+data-live="pull\.merged,run\.finished"/,
    );
    // The run: who, what, the clock from when it started, and x to stop.
    const working = html.slice(
      html.indexOf('id="big-working"'),
      html.indexOf('id="big-map"'),
    );
    expect(working).toContain(`data-key="run:${running.id}"`);
    expect(working).toContain(`data-href="/big?run=${running.id}"`);
    expect(working).toContain('data-state="working"');
    expect(working).toContain("Checkout keeps the total steady");
    expect(working).toContain("building it");
    expect(working).toMatch(/data-started="[^"]+"/);
    expect(working).toContain(`data-act="x"`);
    expect(working).toContain(`form="stop-${running.id}"`);
    expect(working).toContain(`action="/alice/shop/runs/${running.id}/cancel"`);
    expect(working).toContain("<b>1</b> of 1 slots");
    // The map drew the issue the crew is on, ringed, with a key.
    const map = html.slice(
      html.indexOf('id="big-map"'),
      html.indexOf('id="big-landed"'),
    );
    expect(map).toContain('class="map-node"');
    expect(map).toContain('data-state="working"');
    expect(map).toContain(`data-key="issue:${told.value.id}"`);
    expect(map).toContain("<b>1</b> working");
    // The footer offers the lists, each with where it goes.
    expect(html).toMatch(
      /data-k="r"\s+data-go="\/big\?app=alice%2Fshop&amp;list=runs"/,
    );
    expect(html).toMatch(
      /data-k="p"\s+data-go="\/big\?app=alice%2Fshop&amp;list=pulls"/,
    );
    expect(html).toMatch(
      /data-k="m"\s+data-go="\/big\?app=alice%2Fshop&amp;list=map"/,
    );

    // The run's own view: the transcript, following, and the steer line.
    const run = await (await get(`/big?run=${running.id}`)).text();
    expect(run).toContain('data-view="run"');
    expect(run).toContain('data-back="/big?app=alice%2Fshop"');
    expect(run).toContain('id="run-log"');
    expect(run).toContain(
      `data-stream="/api/v1/repos/alice/shop/runs/${running.id}/log?follow=1"`,
    );
    expect(run).toContain('id="run-steer"');
    expect(run).toContain(`action="/alice/shop/runs/${running.id}/steer"`);
    expect(run).toContain('data-running="1"');
    expect(run).toMatch(/id="run-stop"\s+data-act="x"/);

    // The lists.
    const runs = await (await get("/big?app=alice%2Fshop&list=runs")).text();
    expect(runs).toContain('data-view="list"');
    expect(runs).toContain(`data-key="run:${running.id}"`);
    expect(runs).toContain(`data-key="run:${check.id}"`);
    const pulls = await (await get("/big?app=alice%2Fshop&list=pulls")).text();
    expect(pulls).toContain(`data-key="pull:${pull.id}"`);
    expect(pulls).toContain('data-word="green"');
    expect(pulls).toContain(`form="ship-${pull.id}"`);
    const issues = await (
      await get("/big?app=alice%2Fshop&list=issues")
    ).text();
    expect(issues).toContain(`data-key="issue:${told.value.id}"`);
    expect(issues).toContain('data-word="working"');
    // Home now counts them.
    const home = await (await get("/big")).text();
    expect(home).toMatch(/1\s+working/);
    // Somebody else's app, or none: not found, never a hint of it.
    expect((await get("/big?app=alice%2Fnowhere")).status).toBe(404);
    expect((await get("/big?run=nothing")).status).toBe(404);
  });

  test("board and map inside the shell, focusable", async () => {
    const board = await (await get("/big?view=board")).text();
    expect(board).toContain('data-view="board"');
    expect(board).toContain('data-layout="wall"');
    expect(board).toMatch(/id="working"\s+data-live="run\.\*"/);
    expect(board).toMatch(/id="today"\s+data-live="run\.\*,pull\.merged"/);
    expect(board).toContain('class="board-card board-run"');
    expect(board).toMatch(/data-key="run:[^"]+"/);
    expect(board).toMatch(/data-key="app:alice\/notes"/);
    const map = await (await get("/big?view=map")).text();
    expect(map).toContain('data-view="map"');
    expect(map).toMatch(
      /id="map-lanes"\s+data-live="run\.\*,issue\.\*,pull\.\*"/,
    );
    expect(map).toContain('data-key="lane:alice/shop"');
    expect(map).toContain('data-href="/big?app=alice%2Fshop"');
    expect(map).toContain('class="map-lane"');
  });

  test("the command line's targets are pages, and the sheet lists every key the footer shows", async () => {
    const home = await (await get("/big")).text();
    const apps = /data-apps="([^"]*)"/.exec(home)![1]!.split(" ");
    for (const c of COMMANDS) {
      if (c.name === "help") continue;
      const parsed = parseCommand(
        c.arg === undefined ? c.name : `${c.name} shop`,
        { app: "alice/shop", apps },
      );
      expect(parsed.kind).toBe("go");
      if (parsed.kind !== "go") continue;
      const res = await get(parsed.url);
      expect([200, 303]).toContain(res.status);
      if (res.status === 303) {
        // :q leaves for the web UI, which sends a studio reader to its home.
        expect(res.headers.get("location")).not.toContain("/signin");
      }
    }
    for (const path of [
      "/big",
      "/big?app=alice%2Fshop",
      "/big?app=alice%2Fshop&list=runs",
      "/big?view=board",
      "/big?view=map",
    ]) {
      const html = await (await get(path)).text();
      const foot = kbdsIn(html, "big-foot");
      const sheet = kbdsIn(html, "big-help");
      expect(foot.size).toBeGreaterThan(5);
      for (const k of foot) expect(sheet.has(k)).toBe(true);
      // Every command has a line on the sheet.
      for (const c of COMMANDS) expect(html).toContain(`:${c.name}`);
    }
  });
});
