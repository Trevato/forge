/**
 * The studio: search, today's cost, the outline, Stop and Redeploy, names,
 * empty lists, the app's own words, and a run's transcript. One of the
 * files the studio's suite was split into so no one file sets the gate's
 * floor (#2038); the rest are test/studio*.test.ts. It runs in about 2.3 s,
 * every test under 1 s, one fixture per describe, nothing sleeps (#3576).
 */

import { logBox } from "../src/web/studio/log.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { enableApp } from "../src/actions/apps.ts";
import { previewEnv } from "../src/apps/data.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { getAppByRepo } from "../src/core/apps.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import {
  commitToBranch,
  createRepo,
  updateRepoSettings,
} from "../src/actions/repos.ts";
import { getIssue, type Issue } from "../src/core/issues.ts";
import type { Pull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import {
  claimRun,
  createRun,
  finishRun,
  listRuns,
  noteRunProgress,
  type Run,
} from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";
import { withScripts } from "./helpers/page-script.ts";

describe("finding things in the studio: /search", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let aliceCookie: string;
  let widgets: Repo;
  let tellNumber: number;
  let changeNumber: number;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-studio-search-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;

    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
    });
    if (!a.ok) throw new Error(a.error);
    promote(app.db, a.value);
    alice = a.value;
    aliceCookie = (
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

    const made = await createRepo(app, alice, {
      name: "widgets",
      visibility: "public",
      description: "Sell handmade wooden chess sets",
    });
    if (!made.ok) throw new Error(String(made.error));
    widgets = made.value;
    const seeded = await commitToBranch(app, alice, widgets, {
      message: "Start",
      files: [{ path: "README.md", content: "start\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, alice, widgets, { slug: "widgets" });
    if (!enabled.ok) throw new Error(String(enabled.error));

    const told = openIssue(app, alice, widgets, {
      title: "Add a chess clock timer",
      body: "Players want a clock.",
    });
    if (!told.ok) throw new Error(String(told.error));
    tellNumber = told.value.number;

    const branchMade = await commitToBranch(app, alice, widgets, {
      branch: "chess-clock",
      base: widgets.defaultBranch,
      message: "Add clock",
      files: [{ path: "clock.ts", content: "export {};\n" }],
    });
    if (!branchMade.ok) throw new Error(JSON.stringify(branchMade.error));
    const opened = await openPull(app, alice, widgets, {
      title: "Wire up the chess clock",
      body: "",
      baseBranch: widgets.defaultBranch,
      headBranch: "chess-clock",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    changeNumber = opened.value.number;

    // A private app, another owner's — never in alice's or a stranger's
    // results, however much its description matches.
    const bob = await createUser(app.db, { origin: "seed", trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!bob.ok) throw new Error(bob.error);
    promote(app.db, bob.value);
    const secret = await createRepo(app, bob.value, {
      name: "secret",
      visibility: "private",
      description: "A private chess engine",
    });
    if (!secret.ok) throw new Error(String(secret.error));
    const secretSeeded = await commitToBranch(app, bob.value, secret.value, {
      message: "Start",
      files: [{ path: "README.md", content: "start\n" }],
    });
    if (!secretSeeded.ok) throw new Error(JSON.stringify(secretSeeded.error));
    const secretEnabled = await enableApp(app, bob.value, secret.value, {
      slug: "secret",
    });
    if (!secretEnabled.ok) throw new Error(String(secretEnabled.error));
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const asAlice = (path: string) =>
    fetch(`${base}${path}`, {
      headers: { cookie: `${aliceCookie}; forge_mode=studio` },
      redirect: "manual",
    });
  const anonymous = (path: string) =>
    fetch(`${base}${path}`, {
      headers: { cookie: "forge_mode=studio" },
      redirect: "manual",
    });
  // The topbar carries the palette's own list of apps on every page, so an
  // assertion about the *results* reads the main content, not the whole
  // document.
  const mainOf = (html: string): string =>
    html.match(/<main[^>]*id="main"[\s\S]*?<\/main>/)?.[0] ?? html;

  test("an app is found by a word from its own description", async () => {
    const res = await asAlice("/search?q=chess");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("widgets");
    expect(html).toContain("chess sets");
    // Bob's private app matches the same word but is never the viewer's to see.
    expect(html).not.toContain("secret");
  });

  test("a change and a tell are found too, each saying which app they belong to", async () => {
    const html = await (await asAlice("/search?q=chess")).text();
    expect(html).toContain("Add a chess clock timer");
    expect(html).toContain(`/alice/widgets/issues/${tellNumber}`);
    expect(html).toContain("Wire up the chess clock");
    expect(html).toContain(`/alice/widgets/pulls/${changeNumber}`);
    expect(html).toContain("alice/widgets");
  });

  test("the filter form and chips are drawn with §5's bar, never .filters", async () => {
    for (const path of ["/search?q=chess", "/search"]) {
      const html = await (await asAlice(path)).text();
      expect(html).toContain('role="search"');
      expect(html).not.toContain('class="filters"');
    }
    const html = mainOf(await (await asAlice("/search?q=chess")).text());
    expect(html).toMatch(/<form\s+class="bar mb"[^>]*role="search"/);
    expect(html).toMatch(/<div class="bar mb">\s*<div class="seg">/);
    expect(html).toContain("Apps &amp; repos");
  });

  test("results are rows under a heading, not a boxed card", async () => {
    const html = mainOf(await (await asAlice("/search?q=chess")).text());
    expect((html.match(/<ul class="list">/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(html).not.toContain('class="card');
    expect(html).toMatch(/<section id="repos"[^>]*>\s*<h2 class="mt" id="h-repos">/);
  });

  test("an empty query is an empty result, not an error page", async () => {
    const res = await asAlice("/search");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(mainOf(html)).not.toContain("widgets");
  });

  test("an overlong query is bounded, not a crash", async () => {
    const res = await asAlice(`/search?q=${"chess ".repeat(100)}`);
    expect(res.status).toBe(200);
  });

  test("signed out, the same public visibility as dev's own search", async () => {
    const html = await (await anonymous("/search?q=chess")).text();
    expect(html).toContain("widgets");
    expect(html).not.toContain("secret");
  });

  test("?mode=dev on the same route answers the same one page", async () => {
    for (const html of [
      await (await asAlice("/search?q=chess")).text(),
      await (
        await fetch(`${base}/search?q=chess`, {
          headers: { cookie: `${aliceCookie}; forge_mode=dev` },
        })
      ).text(),
    ]) {
      expect(html).toContain("Apps and repositories");
      expect(html).toContain("Issues and pull requests");
      expect(html).toContain(`/alice/widgets/issues/${tellNumber}`);
      expect(mainOf(html)).not.toContain('name="mode"');
    }
  });

  // #397, carrying #241's rule: the one search finds every repository the
  // viewer can see, not only apps — and a tell on it links where it lives.
  test("a repository that is not an app is found by its name and its description, and stays its owner's alone", async () => {
    const plain = await createRepo(app, alice, {
      name: "project-notes",
      visibility: "private",
      description: "notes about a project",
    });
    if (!plain.ok) throw new Error(String(plain.error));
    const told = openIssue(app, alice, plain.value, {
      title: "Sort the project notes",
      body: "",
    });
    if (!told.ok) throw new Error(String(told.error));

    const byName = mainOf(await (await asAlice("/search?q=notes")).text());
    expect(byName).toContain('href="/alice/project-notes"');
    expect(byName).toContain(
      `href="/alice/project-notes/issues/${told.value.number}"`,
    );
    expect(byName).not.toContain("Nothing matched");
    const byDescription = mainOf(
      await (await asAlice("/search?q=about+a+project")).text(),
    );
    expect(byDescription).toContain('href="/alice/project-notes"');

    const stranger = mainOf(await (await anonymous("/search?q=notes")).text());
    expect(stranger).not.toContain("project-notes");
  });

  test("a private app on a public repository: its state reaches only its writers, and anyone else sees a plain repository row", async () => {
    const made = await createRepo(app, alice, {
      name: "abacus",
      visibility: "public",
      description: "an abacus for chess clocks",
    });
    if (!made.ok) throw new Error(String(made.error));
    const seeded = await commitToBranch(app, alice, made.value, {
      message: "Start",
      files: [{ path: "README.md", content: "start\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, alice, made.value, {
      slug: "abacus",
      access: "private",
    });
    if (!enabled.ok) throw new Error(String(enabled.error));
    const carol = await createUser(app.db, { origin: "seed", trusted: true,
      username: "carol",
      email: "carol@forge.local",
      password: "a-good-passphrase",
    });
    if (!carol.ok) throw new Error(carol.error);
    promote(app.db, carol.value);
    const carolCookie = (
      (
        await fetch(`${base}/signin`, {
          method: "POST",
          body: new URLSearchParams({
            username: "carol",
            password: "a-good-passphrase",
          }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
    const rowOf = (html: string): string => {
      const at = html.indexOf('href="/alice/abacus"');
      return at === -1 ? "" : html.slice(at, html.indexOf("</a>", at));
    };
    for (const cookie of ["", `${carolCookie}; forge_mode=studio`]) {
      const html = mainOf(
        await (
          await fetch(`${base}/search?q=abacus`, {
            headers: cookie === "" ? {} : { cookie },
          })
        ).text(),
      );
      const row = rowOf(html);
      expect(row).not.toBe("");
      expect(row).not.toContain("not running");
      expect(row).not.toContain('class="dot"');
    }
    expect(rowOf(mainOf(await (await asAlice("/search?q=abacus")).text()))).toContain(
      "not running",
    );
  });

  test("code is a section of the same page, and narrowing to it is a chip, never a mode", async () => {
    const all = mainOf(await (await asAlice("/search?q=chess")).text());
    expect(all).toContain('id="repos"');
    expect(all).toContain('id="issues"');
    expect(all).toContain('id="code"');
    expect(all).toContain("/search?q=chess&amp;kind=code");
    expect(all).not.toContain("mode=dev");
    expect(all).not.toContain("Search the code");

    const code = mainOf(await (await asAlice("/search?q=chess&kind=code")).text());
    expect(code).toContain('id="code"');
    expect(code).not.toContain('id="repos"');
  });
});

/**
 * The studio home's own answer to "what is this costing me today?" (#94):
 * one line, the sum of today's agent spend across the apps the viewer can
 * write, and how many of those sit paused at their ceiling right now.
 */
describe("the studio home says what the crew cost you today", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let aliceCookie: string;
  let carolCookie: string;

  const signIn = async (username: string): Promise<string> =>
    (
      (
        await fetch(`${base}/signin`, {
          method: "POST",
          body: new URLSearchParams({
            username,
            password: "a-good-passphrase",
          }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;

  // The cost line is the apps list's (#599: home is the feed).
  const home = (cookie: string) =>
    fetch(`${base}/apps`, {
      headers: { cookie: `${cookie}; forge_mode=studio` },
      redirect: "manual",
    }).then((r) => r.text());

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-studio-cost-today-"));
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
    promote(app.db, a.value);
    alice = a.value;
    const c = await createUser(app.db, { origin: "seed", trusted: true,
      username: "carol",
      email: "carol@forge.local",
      password: "a-good-passphrase",
    });
    if (!c.ok) throw new Error(c.error);
    promote(app.db, c.value);
    aliceCookie = await signIn("alice");
    carolCookie = await signIn("carol");

    // "beacon": on its own, over its $5 ceiling today — paused.
    const beaconMade = await createRepo(app, alice, {
      name: "beacon",
      visibility: "public",
      description: "a light that stays on",
    });
    if (!beaconMade.ok) throw new Error(String(beaconMade.error));
    const beacon = beaconMade.value;
    const beaconSeeded = await commitToBranch(app, alice, beacon, {
      message: "Start",
      files: [{ path: "README.md", content: "beacon\n" }],
    });
    if (!beaconSeeded.ok) throw new Error(JSON.stringify(beaconSeeded.error));
    const beaconEnabled = await enableApp(app, alice, beacon, {
      slug: "beacon",
    });
    if (!beaconEnabled.ok) throw new Error(String(beaconEnabled.error));
    const keeper = await createAgent(app, alice, { username: "keeper" });
    if (!keeper.ok) throw new Error(String(keeper.error));
    expect(addToCrew(app, alice, beacon, "keeper").ok).toBe(true);
    const on = await updateRepoSettings(app, alice, beacon, {
      autonomy: "assisted",
      autonomyDirection: "",
      autonomyCeilingUsd: 5,
      autonomySlots: 2,
      autonomyBy: alice.id,
    });
    expect(on.ok).toBe(true);
    const keeperId = getUserByName(app.db, "keeper")!.id;
    const beaconRun = createRun(app.db, {
      repoId: beacon.id,
      kind: "agent",
      actorId: keeperId,
      reason: "assigned",
    });
    claimRun(app.db, beaconRun.id);
    noteRunProgress(app.db, beaconRun.id, { costUsd: 6 });

    // "loom": no autonomy at all, a cheaper run today — never paused.
    const loomMade = await createRepo(app, alice, {
      name: "loom",
      visibility: "public",
      description: "a place for cloth",
    });
    if (!loomMade.ok) throw new Error(String(loomMade.error));
    const loom = loomMade.value;
    const loomSeeded = await commitToBranch(app, alice, loom, {
      message: "Start",
      files: [{ path: "README.md", content: "loom\n" }],
    });
    if (!loomSeeded.ok) throw new Error(JSON.stringify(loomSeeded.error));
    const loomEnabled = await enableApp(app, alice, loom, { slug: "loom" });
    if (!loomEnabled.ok) throw new Error(String(loomEnabled.error));
    const weaver = await createAgent(app, alice, { username: "weaver" });
    if (!weaver.ok) throw new Error(String(weaver.error));
    expect(addToCrew(app, alice, loom, "weaver").ok).toBe(true);
    const weaverId = getUserByName(app.db, "weaver")!.id;
    const loomRun = createRun(app.db, {
      repoId: loom.id,
      kind: "agent",
      actorId: weaverId,
      reason: "assigned",
    });
    claimRun(app.db, loomRun.id);
    noteRunProgress(app.db, loomRun.id, { costUsd: 2 });
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the owner sees the day's total across both apps, and the one that is paused at its ceiling", async () => {
    const html = await home(aliceCookie);
    expect(html).toContain("$8.00 spent today across 2 apps you can write");
    expect(html).toContain("1 paused at");
    expect(html).toMatch(/<a href="\/board">their ceiling<\/a>/);
  });

  test("a viewer who can only read sees no figure at all", async () => {
    const html = await home(carolCookie);
    expect(html).not.toContain("spent today");
    expect(html).not.toContain("$8.00");
    expect(html).not.toContain("$6");
    expect(html).not.toContain("$2");
  });
});

describe("every studio page's headings form one outline", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let repo: Repo;
  let cookie: string;
  let issueNumber: number;
  let pullNumber: number;
  let runId: string;

  const get = (path: string) =>
    fetch(`${base}${path}`, {
      headers: { cookie: `${cookie}; forge_mode=studio` },
      redirect: "manual",
    });

  /** Every `<hN>` tag in document order, and whether the outline it forms
   * is one a heading-jumping reader can follow: exactly one `<h1>`, and
   * never a level deeper than one past the deepest seen so far. */
  function headingOutline(html: string): { levels: number[]; ok: boolean } {
    const levels = [...html.matchAll(/<h([1-6])(?:[ >])/g)].map((m) =>
      Number(m[1]),
    );
    const h1s = levels.filter((l) => l === 1).length;
    let deepest = 0;
    let skipped = false;
    for (const level of levels) {
      if (level > deepest + 1) skipped = true;
      deepest = Math.max(deepest, level);
    }
    return { levels, ok: h1s === 1 && !skipped };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-studio-outline-"));
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
    promote(app.db, a.value);
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
    const made = await createRepo(app, alice, {
      name: "outline",
      visibility: "private",
      description: "for the outline",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [
        {
          path: "package.json",
          content:
            '{"name":"outline","scripts":{"start":"bun run server.ts"}}\n',
        },
        {
          path: "server.ts",
          content:
            "Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('ok') });\n",
        },
      ],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, alice, repo, { slug: "outline" });
    if (!enabled.ok) throw new Error(String(enabled.error));

    const told = openIssue(app, alice, repo, {
      title: "Outline test tell",
      body: "for the heading walk",
    });
    if (!told.ok) throw new Error(String(told.error));
    issueNumber = told.value.number;

    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/outline",
      base: "main",
      message: "Outline change",
      files: [{ path: "OUTLINE.md", content: "outline\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "Outline test change",
      body: "",
      baseBranch: "main",
      headBranch: "feature/outline",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    pullNumber = opened.value.number;
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      actorId: alice.id,
      reason: "assigned",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "ok", summary: "done" });
    runId = run.id;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the studio home has exactly one h1, said in the studio's own words, and no skipped heading level", async () => {
    const html = await (await get("/")).text();
    const outline = headingOutline(html);
    expect(outline.levels.filter((l) => l === 1).length).toBe(1);
    expect(outline.ok).toBe(true);
    expect(html).toMatch(/<h1 class="sr-only">Home<\/h1>/);
  });

  test("the app page, the three lists, a tell, a change and a run each have one outline with no skipped level", async () => {
    const pages: Record<string, string> = {
      "the app page": "/alice/outline",
      "everything told": "/alice/outline/issues",
      "every change": "/alice/outline/pulls",
      "every run": "/alice/outline/runs",
      "a tell": `/alice/outline/issues/${issueNumber}`,
      "a change": `/alice/outline/pulls/${pullNumber}`,
      "a run": `/alice/outline/runs/${runId}`,
      settings: "/alice/outline/settings",
    };
    for (const [name, path] of Object.entries(pages)) {
      const html = await (await get(path)).text();
      const outline = headingOutline(html);
      if (
        outline.levels[0] !== 1 ||
        outline.levels.filter((l) => l === 1).length !== 1 ||
        !outline.ok
      )
        throw new Error(`${name} (${path}): ${JSON.stringify(outline)}`);
    }
  });
});

/**
 * Issue #205: the studio's head card has three buttons, and two of them used
 * to leave the studio — Stop for dev's App page, Redeploy for the deploy's
 * run page. Both now come back to the page the form was pressed on, because
 * the card refreshes itself on the deploy event and staying put shows the
 * result. Dev mode's Redeploy still hands over to the run, and the page is
 * taken from the referer only when it is this forge's own (`safeBack`),
 * never from the form.
 */
describe("the studio's Stop and Redeploy come back to the page they were pressed on", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let repo: Repo;
  let runtime: AppsRuntime;
  let cookie: string;

  /** A form the head card draws, submitted from `from` in one of the modes. */
  const press = (
    what: "stop" | "redeploy",
    mode: "studio" | "dev",
    from: string | undefined,
  ): Promise<Response> => {
    const headers: Record<string, string> = {
      cookie: `${cookie}; forge_mode=${mode}`,
      origin: base,
    };
    if (from !== undefined) headers["referer"] = from;
    return fetch(`${base}/alice/notes/app/production/${what}`, {
      method: "POST",
      headers,
      body: new URLSearchParams({}),
      redirect: "manual",
    });
  };

  /** The flash a redirect carries, decoded from its cookie. */
  const flashOf = (response: Response): string =>
    decodeURIComponent(response.headers.get("set-cookie") ?? "");

  const studioPage = (): Promise<string> =>
    fetch(`${base}/alice/notes`, {
      headers: { cookie: `${cookie}; forge_mode=studio` },
      redirect: "manual",
    }).then((r) => r.text());

  /**
   * Production serving, as the runtime holds it, without running a real
   * deploy — the pages read `runtime.status(record)`, and `stopEnv` only
   * asks the handle to stop. Same shape the "not up" head's `put` uses.
   */
  const putLive = (): void => {
    (
      runtime as unknown as { envs: Map<string, Record<string, unknown>> }
    ).envs.set(`${getAppByRepo(app.db, repo.id)!.id}/production`, {
      app: getAppByRepo(app.db, repo.id)!,
      env: "production",
      chain: Promise.resolve(),
      restarts: [],
      live: {
        commitOid: "a".repeat(40),
        handle: { port: 4321, stop: async () => {} },
        runId: "fake",
        since: new Date().toISOString(),
        manifest: { tty: null },
      },
    });
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-studio-envback-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    runtime = new AppsRuntime(app, {
      domain: "apps.test",
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
    promote(app.db, a.value);
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
    const made = await createRepo(app, a.value, {
      name: "notes",
      visibility: "public",
      description: "a place for notes",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, a.value, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "notes\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const branched = await commitToBranch(app, a.value, repo, {
      branch: "spelling",
      message: "Fix a word",
      files: [{ path: "README.md", content: "notes.\n" }],
    });
    if (!branched.ok) throw new Error(JSON.stringify(branched.error));
    const pull = await openPull(app, a.value, repo, {
      title: "Fix a word",
      body: "",
      headBranch: "spelling",
      baseBranch: repo.defaultBranch,
    });
    if (!pull.ok) throw new Error(String(pull.error));
    const enabled = await enableApp(app, a.value, repo, { slug: "notes" });
    if (!enabled.ok) throw new Error(String(enabled.error));
  });

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("Stop returns to the app's studio page with its flash, not to dev's App page", async () => {
    const stopped = await press("stop", "studio", `${base}/alice/notes`);
    expect(stopped.status).toBe(303);
    expect(stopped.headers.get("location")).toBe("/alice/notes");
    expect(flashOf(stopped)).toContain(
      "Stopped production. Its data is kept; Redeploy brings it back.",
    );
    // And the flash really lands on that page, in front of the person.
    const flash = (stopped.headers.get("set-cookie") ?? "").split(";")[0]!;
    const landed = await fetch(`${base}/alice/notes`, {
      headers: { cookie: `${cookie}; forge_mode=studio; ${flash}` },
      redirect: "manual",
    });
    expect(landed.status).toBe(200);
    expect((await landed.text()).replace(/\s+/g, " ")).toContain(
      "Stopped production. Its data is kept; Redeploy brings it back.",
    );
  });

  test("the head card shows the new state where it stands: the live fragment, no second navigation", async () => {
    putLive();
    const serving = await studioPage();
    expect(await withScripts(base, serving)).toContain("serving");
    expect(serving).toContain('href="/-/confirm?to=%2Falice%2Fnotes%2Fapp%2Fproduction%2Fstop"');
    // The page a person stays on is the one that refreshes itself: its live
    // mount asks for the app's state on a deploy event.
    expect(serving).toContain('data-app="1"');

    const stopped = await press("stop", "studio", `${base}/alice/notes`);
    expect(stopped.headers.get("location")).toBe("/alice/notes");

    // What the live client fetches, with no navigation in between: the same
    // head card, now saying the app is down and offering Redeploy instead.
    const fragment = await fetch(`${base}/alice/notes/app/state`, {
      headers: { cookie: `${cookie}; forge_mode=studio` },
      redirect: "manual",
    });
    expect(fragment.status).toBe(200);
    const html = (await fragment.text()).replace(/\s+/g, " ");
    expect(html).toContain('id="app-head"');
    expect(html).toContain("not running");
    expect(html).toContain('action="/alice/notes/app/production/redeploy"');
    expect(html).not.toContain('href="/-/confirm?to=%2Falice%2Fnotes%2Fapp%2Fproduction%2Fstop"');
  });

  test("pressed on a change's page, Stop comes back to that change", async () => {
    const stopped = await press(
      "stop",
      "studio",
      `${base}/alice/notes/pulls/1`,
    );
    expect(stopped.status).toBe(303);
    expect(stopped.headers.get("location")).toBe("/alice/notes/pulls/1");
  });

  test("no referer, or one from somewhere else, falls back to the app's studio page — never the raw /app", async () => {
    for (const from of [undefined, "https://evil.example/alice/notes"]) {
      const stopped = await press("stop", "studio", from);
      expect(stopped.status).toBe(303);
      expect(stopped.headers.get("location")).toBe("/alice/notes");
    }
  });

  test("Redeploy stays on the page too, instead of leaving for the deploy's run page", async () => {
    const queued = await press("redeploy", "studio", `${base}/alice/notes`);
    expect(queued.status).toBe(303);
    expect(queued.headers.get("location")).toBe("/alice/notes");
    expect(queued.headers.get("location")).not.toContain("/runs/");
    expect(flashOf(queued)).toContain("Redeploying production.");
    // A run was really queued: the studio only chose not to navigate to it.
    expect(
      listRuns(app.db, repo.id, { kind: "deploy", limit: 5 }).length,
    ).toBeGreaterThan(0);
  });

  test("dev mode is the same: Stop and Redeploy both come back to the page they were pressed on", async () => {
    const stopped = await press("stop", "dev", `${base}/alice/notes/pulls/1`);
    expect(stopped.status).toBe(303);
    expect(stopped.headers.get("location")).toBe("/alice/notes/pulls/1");
    expect(flashOf(stopped)).toContain("Stopped production.");

    const queued = await press("redeploy", "dev", `${base}/alice/notes`);
    expect(queued.status).toBe(303);
    expect(queued.headers.get("location")).toBe("/alice/notes");
    expect(flashOf(queued)).toContain("Redeploying production.");
  });

  // Issue #395: dev's App page folded into this one. Its URL keeps
  // answering — a redirect to the studio app page — and the environment
  // controls it carried (each preview's Redeploy and Stop, the way to the
  // environment settings) are drawn here instead.
  test("GET /:owner/:name/app redirects to the app page, for a dev browser too", async () => {
    const asStudio = await fetch(`${base}/alice/notes/app`, {
      headers: { cookie: `${cookie}; forge_mode=studio` },
      redirect: "manual",
    });
    expect(asStudio.status).toBe(302);
    expect(asStudio.headers.get("location")).toBe("/alice/notes");

    const asDev = await fetch(`${base}/alice/notes/app`, {
      headers: { cookie: `${cookie}; forge_mode=dev` },
      redirect: "manual",
    });
    expect(asDev.status).toBe(302);
    expect(asDev.headers.get("location")).toBe("/alice/notes");
    const landed = await fetch(`${base}/alice/notes`, {
      headers: { cookie: `${cookie}; forge_mode=dev` },
      redirect: "manual",
    });
    expect(landed.status).toBe(200);
    expect(await landed.text()).toContain('id="app-head"');

    // A public app's page is anyone's; the redirect is too.
    const anonymous = await fetch(`${base}/alice/notes/app`, {
      redirect: "manual",
    });
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get("location")).toBe("/alice/notes");
  });

  test("GET /:owner/:name/app is still not found for a repository that is not an app, or not there", async () => {
    const alice = getUserByName(app.db, "alice")!;
    const plain = await createRepo(app, alice, {
      name: "plain-notes",
      visibility: "public",
    });
    if (!plain.ok) throw new Error(String(plain.error));
    for (const path of ["/alice/plain-notes/app", "/alice/nowhere/app"]) {
      const response = await fetch(`${base}${path}`, {
        headers: { cookie: `${cookie}; forge_mode=studio` },
        redirect: "manual",
      });
      expect(`${path} → ${response.status}`).toBe(`${path} → 404`);
    }
  });

  test("the studio app page carries each preview's Redeploy and Stop, and the environment settings, for a writer only", async () => {
    const record = getAppByRepo(app.db, repo.id)!;
    const env = previewEnv(1);
    (
      runtime as unknown as { envs: Map<string, Record<string, unknown>> }
    ).envs.set(`${record.id}/${env}`, {
      app: record,
      env,
      chain: Promise.resolve(),
      restarts: [],
      live: {
        commitOid: "b".repeat(40),
        handle: { port: 4322, stop: async () => {} },
        runId: "fake-preview",
        since: new Date().toISOString(),
        manifest: { tty: null },
      },
    });
    const owner = await studioPage();
    expect(owner).toContain(`action="/alice/notes/app/${env}/redeploy"`);
    expect(owner).toContain(`href="/-/confirm?to=%2Falice%2Fnotes%2Fapp%2F${env}%2Fstop"`);
    expect(owner).toContain(`href="/alice/notes/app/${env}/open"`);
    expect(owner).toContain('href="/alice/notes/settings/app"');

    const stranger = await (
      await fetch(`${base}/alice/notes`, { redirect: "manual" })
    ).text();
    expect(stranger).toContain(`href="/alice/notes/app/${env}/open"`);
    expect(stranger).not.toContain("/redeploy");
    expect(stranger).not.toContain("%2Fstop");
    expect(stranger).not.toContain('href="/alice/notes/settings/app"');
  });
});

/**
 * Issue #206: one public app, one open change, one anonymous visitor, three
 * studio pages — and they must name the same author. Who signs a row is
 * `voiceFor` (`src/web/studio/voice.ts`): a person is named to anyone who
 * can see the row at all, and only the crew's own work reads as the app's
 * own story for a viewer who cannot see the roster.
 */
describe("the studio names a person on the app's page, and the crew only for the crew's own work", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let repo: Repo;
  let alice: User;
  let ownerCookie: string;
  let personPull: Pull;
  let agentPull: Pull;
  let agentRun: Run;
  let waitingTell: Issue;
  let heldTell: Issue;

  const signIn = async (username: string): Promise<string> =>
    (
      (
        await fetch(`${base}/signin`, {
          method: "POST",
          body: new URLSearchParams({
            username,
            password: "a-good-passphrase",
          }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;

  /** Signed out, in studio mode: the visitor the issue walked as. */
  const anon = async (path: string): Promise<string> =>
    (
      await fetch(`${base}${path}`, {
        headers: { cookie: "forge_mode=studio" },
        redirect: "manual",
      })
    ).text();

  const owner = async (path: string): Promise<string> =>
    (
      await fetch(`${base}${path}`, {
        headers: { cookie: `${ownerCookie}; forge_mode=studio` },
        redirect: "manual",
      })
    ).text();

  /** The one `<li>` a link sits in — one row, not the whole page. */
  const rowWith = (page: string, needle: string): string => {
    const at = page.indexOf(needle);
    expect(at).toBeGreaterThan(-1);
    const start = page.lastIndexOf("<li", at);
    const end = page.indexOf("</li>", at);
    return page.slice(start, end);
  };

  /** What the avatar beside a name says, so initials can be held to it. */
  const initialsIn = (row: string): string =>
    row.match(/class="avatar"[\s\S]*?>([^<]*)<\/span/)?.[1]?.trim() ?? "";

  const branchAndPull = async (
    who: User,
    name: string,
    title: string,
  ): Promise<Pull> => {
    const branch = await commitToBranch(app, alice, repo, {
      branch: name,
      base: "main",
      message: title,
      files: [{ path: `${name.replace(/\//g, "-")}.md`, content: `${name}\n` }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, who, repo, {
      title,
      body: "",
      baseBranch: "main",
      headBranch: name,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    return opened.value;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-studio-voice-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "ivy",
      email: "ivy@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    promote(app.db, a.value);
    alice = a.value;
    ownerCookie = await signIn("ivy");

    const made = await createRepo(app, alice, {
      name: "pub",
      visibility: "public",
      description: "a public house",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "pub\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, alice, repo, { slug: "pub" });
    if (!enabled.ok) throw new Error(String(enabled.error));
    const quill = await createAgent(app, alice, { username: "quill" });
    if (!quill.ok) throw new Error(String(quill.error));
    expect(addToCrew(app, alice, repo, "quill").ok).toBe(true);
    const quillUser = getUserByName(app.db, "quill")!;
    const quillId = quillUser.id;

    // The change ivy opened herself, through the web editor.
    personPull = await branchAndPull(alice, "ivy/subtitle", "Add a subtitle");
    // One the crew opened, so the masking that was meant has something to
    // mask on the very same page.
    agentPull = await branchAndPull(quillUser, "quill/lamp", "Hang a lamp");
    // A run of the crew's, on a tell of its own so it keeps its own row.
    const told = openIssue(app, alice, repo, { title: "Sweep the step" });
    if (!told.ok) throw new Error(String(told.error));
    agentRun = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: told.value.id,
      actorId: quillId,
      reason: "assigned",
    });
    claimRun(app.db, agentRun.id);
    agentRun =
      finishRun(app.db, agentRun.id, {
        state: "ok",
        summary: "swept",
        costUsd: 3.5,
        turns: 2,
      }) ?? agentRun;

    // And one nobody has picked up yet: a waiting row, the crew's to take.
    const waiting = openIssue(app, alice, repo, { title: "Wipe the bar" });
    if (!waiting.ok) throw new Error(String(waiting.error));
    expect(assignIssue(app, alice, repo, waiting.value, quillUser).ok).toBe(
      true,
    );
    waitingTell = getIssue(app.db, repo.id, waiting.value.number)!;

    // And one ivy took herself — a person holds it (#226's own row on the
    // panel), so the panel owes her name to whoever can see the row.
    const held = openIssue(app, alice, repo, { title: "Polish the sign" });
    if (!held.ok) throw new Error(String(held.error));
    expect(assignIssue(app, alice, repo, held.value, alice).ok).toBe(true);
    heldTell = getIssue(app.db, repo.id, held.value.number)!;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an anonymous visitor reads one author for one change on all three pages, avatar included", async () => {
    const appPage = await anon("/ivy/pub");
    const changes = await anon("/ivy/pub/pulls");
    const change = await anon(`/ivy/pub/pulls/${personPull.number}`);

    const onApp = rowWith(appPage, `/pulls/${personPull.number}`);
    const onList = rowWith(changes, `/pulls/${personPull.number}`);
    expect(onApp).toContain("ivy");
    expect(onApp).not.toContain("the crew");
    // The same name the list gives; the list's row wears a status dot in
    // place of an avatar (#8719), so the initials are the app page's alone.
    expect(onList).toContain("ivy");
    expect(onList).not.toContain("the crew");
    expect(initialsIn(onApp)).toBe("i");
    expect(change).toContain("ivy");

    // A tell she took herself is hers on the same panel, by the same rule.
    const held = rowWith(appPage, `/issues/${heldTell.number}`);
    expect(held).toContain("ivy");
    expect(held).not.toContain("the crew");
    expect(initialsIn(held)).toBe("i");
  });

  test("the crew's own change and the crew's own run still read as the crew's to that visitor", async () => {
    const appPage = await anon("/ivy/pub");
    const onApp = rowWith(appPage, `/pulls/${agentPull.number}`);
    expect(onApp).toContain("the crew");
    expect(onApp).not.toContain("quill");
    expect(initialsIn(onApp)).toBe("tc");

    const runRow = rowWith(appPage, `/runs/${agentRun.id}`);
    expect(runRow).toContain("the crew");
    expect(runRow).not.toContain("quill");

    const tellRow = rowWith(appPage, `/issues/${waitingTell.number}`);
    expect(tellRow).toContain("the crew");
    expect(tellRow).not.toContain("quill");

    // Nothing the owner keeps to herself came along with the name.
    expect(appPage).not.toContain("quill");
    expect(appPage).not.toMatch(/\$\d/);
    expect(appPage).not.toContain(">Crew<");
  });

  test("the owner still reads the crew by name, and her own change as her own", async () => {
    const appPage = await owner("/ivy/pub");
    expect(rowWith(appPage, `/pulls/${agentPull.number}`)).toContain("quill");
    expect(rowWith(appPage, `/runs/${agentRun.id}`)).toContain("quill");
    expect(rowWith(appPage, `/pulls/${personPull.number}`)).toContain("ivy");
  });
});

describe("the studio's empty lists", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let cookie: string;

  const get = (path: string) =>
    fetch(`${base}${path}`, {
      headers: { cookie: `${cookie}; forge_mode=studio` },
      redirect: "manual",
    }).then((r) => r.text());

  const setup = async (name: string) => {
    const made = await createRepo(app, alice, {
      name,
      visibility: "private",
      description: "",
    });
    if (!made.ok) throw new Error(String(made.error));
    const seeded = await commitToBranch(app, alice, made.value, {
      message: "Start",
      files: [
        {
          path: "package.json",
          content: '{"name":"x","scripts":{"start":"bun run server.ts"}}\n',
        },
        { path: "server.ts", content: "export {};\n" },
      ],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, alice, made.value, { slug: name });
    if (!enabled.ok) throw new Error(String(enabled.error));
    return made.value;
  };
  let alice: User;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-studio-empty-"));
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
    promote(app.db, a.value);
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
  });

  afterAll(async () => {
    servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a repository with nothing in it says what to do, and blames no filter", async () => {
    await setup("blank");
    for (const [path, words] of [
      ["issues", "Tell the crew what you want"],
      ["pulls", "Nothing open."],
      ["runs", "Nothing open."],
    ] as const) {
      const page = await get(`/alice/blank/${path}`);
      expect(page).toContain(words);
      expect(page).not.toContain("this filter");
    }
  });

  test("a filter that hides every row is named", async () => {
    const repo = await setup("busy");
    const told = openIssue(app, alice, repo, { title: "Add a tab", body: "" });
    if (!told.ok) throw new Error(String(told.error));
    const issues = await get("/alice/busy/issues?word=shipped");
    expect(issues).toContain("No issue is shipped yet.");
    expect(issues).not.toContain("Tell the crew what you want");
    const pulls = await get("/alice/busy/pulls?word=look");
    expect(pulls).toContain("No pull request is look yet.");
    const runs = await get("/alice/busy/runs?word=stopped");
    expect(runs).toContain("No run is stopped yet.");
  });
});

/**
 * Issue #230: the studio's settings page can change the two facts it
 * prints most about an app — description and visibility — by posting to
 * the very same `/:owner/:name/settings` route dev's General page uses.
 */
describe("the studio can change what an app says it is (#230)", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let repo: Repo;
  let ownerCookie: string;
  let readerCookie: string;

  const signIn = async (username: string): Promise<string> =>
    (
      (
        await fetch(`${base}/signin`, {
          method: "POST",
          body: new URLSearchParams({
            username,
            password: "a-good-passphrase",
          }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;

  const get = (path: string, cookie?: string) =>
    fetch(`${base}${path}`, {
      headers: {
        cookie:
          cookie === undefined
            ? "forge_mode=studio"
            : `${cookie}; forge_mode=studio`,
      },
      redirect: "manual",
    });

  const post = (path: string, body: Record<string, string>, cookie: string) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        cookie: `${cookie}; forge_mode=studio`,
        origin: base,
      },
      body: new URLSearchParams(body),
      redirect: "manual",
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-studio-about-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const alice = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!alice.ok) throw new Error(alice.error);
    promote(app.db, alice.value);
    const carol = await createUser(app.db, { origin: "seed", trusted: true,
      username: "carol",
      email: "carol@forge.local",
      password: "a-good-passphrase",
    });
    if (!carol.ok) throw new Error(carol.error);
    promote(app.db, carol.value);
    ownerCookie = await signIn("alice");
    readerCookie = await signIn("carol");
    const made = await createRepo(app, alice.value, {
      name: "lamp",
      visibility: "public",
      description: "lights the hallway",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice.value, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "lamp\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    // Branch protection is on and unexposed by the studio's form — proof
    // that saving from here does not silently turn it off.
    const protectedOn = await updateRepoSettings(app, alice.value, repo, {
      protectDefault: true,
      requireReview: true,
      requireChecks: true,
    });
    if (!protectedOn.ok) throw new Error(String(protectedOn.error));
    repo = protectedOn.value;
    const enabled = await enableApp(app, alice.value, repo, { slug: "lamp" });
    if (!enabled.ok) throw new Error(String(enabled.error));
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a writer changes the description and visibility from the studio, and the app's page and the shelf row show it", async () => {
    // The About card names itself (`card=about`), so a real submit of it —
    // exactly what's posted here — changes its own fields and cannot touch
    // the branch protection it never shows.
    const before = await (
      await get("/alice/lamp/settings", ownerCookie)
    ).text();
    expect(before).toContain('<input type="hidden" name="card" value="about"');

    const saved = await post(
      "/alice/lamp/settings",
      {
        card: "about",
        description: "a lamp that stays lit all night",
        visibility: "private",
      },
      ownerCookie,
    );
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe("/alice/lamp/settings");

    const ownPage = await (
      await get("/alice/lamp", ownerCookie)
    ).text();
    expect(ownPage).toContain("a lamp that stays lit all night");
    expect(ownPage).toContain("Private");

    // `/app` has been a redirect to the studio app page since the dev app
    // page was folded into it (#433): the head to read is that page's.
    const moved = await get("/alice/lamp/app", ownerCookie);
    expect(moved.status).toBe(302);
    expect(moved.headers.get("location")).toBe("/alice/lamp");
    const appHead = await (await get("/alice/lamp", ownerCookie)).text();
    expect(appHead).toContain("Private");

    const shelf = await (await get("/apps", ownerCookie)).text();
    expect(shelf).toContain("a lamp that stays lit all night");

    const list = await (await get("/apps", ownerCookie)).text();
    expect(list).toContain("a lamp that stays lit all night");

    // Branch protection, never shown on this form, is exactly as it was.
    const dbRepo = getRepoById(app.db, repo.id);
    expect(dbRepo?.protectDefault).toBe(true);
    expect(dbRepo?.requireReview).toBe(true);
    expect(dbRepo?.requireChecks).toBe(true);
  });

  test("a reader gets neither control: no form on the settings page, and the post is refused", async () => {
    const settings = await (
      await get("/alice/lamp/settings", readerCookie)
    ).text();
    expect(settings).not.toContain('action="/alice/lamp/settings"');
    expect(settings).not.toContain("<textarea");

    const refused = await post(
      "/alice/lamp/settings",
      { description: "carol was here", visibility: "public" },
      readerCookie,
    );
    expect(refused.status).toBe(404);
    const dbRepo = getRepoById(app.db, repo.id);
    expect(dbRepo?.description).not.toBe("carol was here");
  });
});

describe("a run's transcript window", () => {
  test("a log already cut to its tail offers the last N, never all of the run", () => {
    const lines = ["one", "two", "three"];
    const cut = logBox({ id: "log", who: "scout", cap: 2, lines, allHref: "/x?all=1", truncated: true }).text;
    expect(cut).toContain("read the last");
    expect(cut).not.toContain("read all");
    const whole = logBox({ id: "log", who: "scout", cap: 2, lines, allHref: "/x?all=1" }).text;
    expect(whole).toContain("read all");
  });
});
