/**
 * Browsing a repository that is not here, in a browser.
 *
 * The claim is a workflow: enter opens a repository *live*, nothing is
 * downloaded, every page says where it is reading from, and mirroring is a
 * separate, visible act with progress behind it. So the assertions are about
 * exactly those four things, plus the two that make them safe — a live browse
 * spends somebody's credential, so it is theirs alone and needs the account
 * rather than a token that merely reads.
 *
 * The adversarial half carries the weight. A browse must create nothing. A
 * browse page must contain no way to write, because a live source has no
 * mutation on it at all and a form that would 500 is worse than no form. And
 * another account, and a leaked `ro`/`rw` token, must both get the same 404 a
 * private repository gets.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createToken } from "../src/actions/users.ts";
import { listOrigins } from "../src/core/origins.ts";
import { listReposByOwner } from "../src/core/repos.ts";
import { getUserByName } from "../src/core/users.ts";
import { settled } from "../src/origins/jobs.ts";
import { forgetProviders } from "../src/origins/providers/index.ts";
import { clearViewCache } from "../src/view/cache.ts";
import { quietLogs } from "./helpers/globals.ts";
import { pageScriptOf } from "./helpers/page-script.ts";
import { newFakeState, serveFakeForge, type FakeForge } from "./fake-origin.ts";
import { codeJs, mirrorJs } from "../src/web/client.ts";
import { STAGE_BADGE, STAGE_BADGE_JS } from "../src/web/stage-row.ts";
import { adminCookie, seedAdmin } from "./helpers/admin.ts";

quietLogs();

const ORIGIN_LOGIN = "octo";
const ORIGIN_TOKEN = "octo-origin-secret-7c31";
const PASSWORD = "a-long-web-passphrase";
const README = "# widgets\nlive from the origin\n";
const SOURCE_FILE = "export const gears = 3;\n";

const basic = (user: string, secret: string): string =>
  `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;

describe("browsing an origin repository on the web", () => {
  let dataDir: string;
  let originDataDir: string;
  let app: App;
  let servers: Servers;
  let originApp: App;
  let originServers: Servers;
  let fake: FakeForge;
  let base: string;
  let alice = "";
  let bob = "";
  let originId = "";
  let browse = "";

  const asUser = (
    cookie: string,
    path: string,
    init: RequestInit & { form?: Record<string, string>; origin?: string } = {},
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (cookie !== "") headers.set("cookie", cookie);
    const method = init.form !== undefined ? "POST" : (init.method ?? "GET");
    if (init.form !== undefined)
      headers.set("origin", init.origin ?? new URL(base).origin);
    return fetch(`${base}${path}`, {
      ...init,
      method,
      headers,
      redirect: "manual",
      ...(init.form === undefined
        ? {}
        : { body: new URLSearchParams(init.form) }),
    });
  };

  const bodyOf = async (cookie: string, path: string): Promise<string> => {
    const response = await asUser(cookie, path);
    expect(`${path}:${response.status}`).toBe(`${path}:200`);
    return response.text();
  };

  const signUp = async (username: string): Promise<string> => {
    const response = await fetch(`${base}/signup`, {
      method: "POST",
      body: new URLSearchParams({
        username,
        email: `${username}@forge.test`,
        password: PASSWORD,
      }),
      redirect: "manual",
    });
    return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-webbrowse-"));
    originDataDir = await mkdtemp(join(tmpdir(), "forge-webbrowse-up-"));

    // A second real forge, so the mirror's git fetch speaks real smart HTTP.
    originApp = createApp({ dataDir: originDataDir, port: 0 });
    originServers = await serve(originApp);
    const up = (path: string, body: unknown, auth = true) =>
      fetch(`${originServers.url}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(auth ? { authorization: basic(ORIGIN_LOGIN, ORIGIN_TOKEN) } : {}),
        },
        body: JSON.stringify(body),
      });
    await seedAdmin(originApp, {
      username: ORIGIN_LOGIN,
      email: "octo@upstream.test",
      password: ORIGIN_TOKEN,
    });
    await up("/api/v1/repos", { name: "widgets", visibility: "public" });
    await up("/api/v1/repos/octo/widgets/contents", {
      branch: "main",
      message: "first",
      files: [
        { path: "README.md", content: README },
        { path: "src/index.ts", content: SOURCE_FILE },
      ],
    });
    const upstream = (await (
      await fetch(`${originServers.url}/api/v1/repos/octo/widgets/commits`)
    ).json()) as { oid: string }[];
    const tip = upstream[0]!.oid;

    const state = newFakeState("forgejo", ORIGIN_LOGIN, ORIGIN_TOKEN);
    state.repos.push({
      id: 41,
      fullName: "octo/widgets",
      description: "gears and things",
      cloneUrl: `${originServers.url}/octo/widgets.git`,
      htmlUrl: `${originServers.url}/octo/widgets`,
      defaultBranch: "main",
    });
    state.files.set(
      "octo/widgets",
      new Map([
        ["README.md", README],
        ["src/index.ts", SOURCE_FILE],
      ]),
    );
    state.branches.set("octo/widgets", [{ name: "main", sha: tip }]);
    state.tags.set("octo/widgets", [{ name: "v1", sha: tip }]);
    state.commits.set("octo/widgets", [
      {
        sha: tip,
        message: "first\n\nthe body of it",
        authorName: "Mona Lisa",
        login: "mona",
        date: "2026-01-01T00:00:00.000Z",
        diff: [
          "diff --git a/README.md b/README.md",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/README.md",
          "@@ -0,0 +1,2 @@",
          "+# widgets",
          "+live from the origin",
          "",
        ].join("\n"),
      },
    ]);
    state.labels.set("octo/widgets", [{ id: 1, name: "bug", color: "d73a4a" }]);
    state.issues.set("octo/widgets", [
      {
        id: 900,
        number: 7,
        title: "The gear slips",
        body: "under load",
        user: "mona",
        labels: ["bug"],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
      {
        id: 901,
        number: 9,
        title: "Tighten the bolt",
        user: "hubot",
        createdAt: "2026-01-03T00:00:00.000Z",
        updatedAt: "2026-01-03T00:00:00.000Z",
        pull: {
          base: "main",
          head: "tighten",
          headRepo: "octo/widgets",
          mergedAt: null,
        },
      },
    ]);
    state.comments.set("octo/widgets", [
      {
        id: 500,
        issueNumber: 7,
        body: "seen it too",
        user: "mona",
        createdAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ]);
    fake = serveFakeForge(state);

    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    delete process.env.FORGE_GITHUB_CLIENT_ID;
    alice = await adminCookie(app, { username: "alice", email: "alice@forge.test", password: PASSWORD });
    bob = await signUp("bob");
    forgetProviders(dataDir);

    const connected = await asUser(alice, "/settings/origins/token", {
      form: { host: fake.url, token: ORIGIN_TOKEN },
    });
    expect(connected.status).toBe(303);
    originId = listOrigins(app.db, getUserByName(app.db, "alice")!.id)[0]!.id;
    browse = `/origins/${originId}/r/octo/widgets`;
    clearViewCache();
  });

  afterAll(async () => {
    fake.stop();
    servers.stop();
    originServers.stop();
    app.close();
    originApp.close();
    forgetProviders(dataDir);
    await rm(dataDir, { recursive: true, force: true });
    await rm(originDataDir, { recursive: true, force: true });
  });

  // ---- the browse itself ----

  test("the home page renders the tree and README, and creates nothing", async () => {
    const owner = getUserByName(app.db, "alice")!;
    const before = listReposByOwner(app.db, "alice", owner).length;
    const html = await bodyOf(alice, browse);
    expect(html).toContain("octo");
    expect(html).toContain("widgets");
    // The tree, from the origin's API.
    expect(html).toContain("README.md");
    expect(html).toContain("src");
    // The README, rendered as markdown.
    expect(html).toContain("live from the origin");
    // Not one row was written to get here — that is the whole point.
    expect(listReposByOwner(app.db, "alice", owner)).toHaveLength(before);
  });

  test("the banner says what you are reading and that it is read-only", async () => {
    const html = await bodyOf(alice, browse);
    expect(html).toContain("Reading live from");
    expect(html).toContain(new URL(fake.url).host);
    expect(html).toContain("read-only");
    expect(html).toContain("Mirror it to");
    // The About rail is a §5 card, not the retired `.about` aside.
    expect(html).toContain("Where it lives");
    expect(html).not.toMatch(/class="about"/);
    expect(html).toContain('<aside aria-label="About">');
    expect(html).toMatch(/row-title"[^>]*>Visibility</);
    expect(html).toContain("keep it in sync");
    // And the two things it offers instead of the write buttons.
    expect(html).toContain("Mirror into your workbench");
    expect(html).toContain(`Open on ${new URL(fake.url).host}`);
  });

  test("the About rail is a card: no .about, same words, same mirror form", async () => {
    const html = await bodyOf(alice, browse);
    expect(html).not.toMatch(/class="[^"]*\babout\b/);
    expect(html).not.toContain("<dl");
    const rail = html.match(/<aside[^>]*>[\s\S]*?<\/aside>/)?.[0] ?? "";
    expect(rail).toContain("<h2>About</h2>");
    for (const word of ["Where it lives", "Origin", "Last push", "Visibility", "Default"])
      expect(rail).toContain(word);
    expect(rail).toContain(`action="${browse}/mirror"`);
    expect(rail).toContain("Mirror it");
  });

  test("a live browse never writes to the repository it is reading", async () => {
    for (const path of [
      browse,
      `${browse}/tree/main`,
      `${browse}/blob/main/README.md`,
      `${browse}/commits`,
      `${browse}/issues`,
      `${browse}/issues/7`,
      `${browse}/pulls`,
      `${browse}/pulls/9`,
    ]) {
      const html = await bodyOf(alice, path);
      // Every POST a browse page carries creates something *for you* — a
      // copy here, a fork of your own there, a proposal on it. None of them
      // changes the repository being read, because a live `RepoSource` has
      // no mutation on it at all. (Theme and sign out are the shell's, on
      // every page in the product.)
      const forms = [...html.matchAll(/<form[\s\S]*?>/g)].map((m) => m[0]);
      const posts = forms
        .filter((tag) => tag.includes('method="post"'))
        .map((tag) => /action="([^"]*)"/.exec(tag)?.[1] ?? "");
      for (const action of posts) {
        const allowed =
          action.endsWith("/mirror") ||
          action.endsWith("/fork") ||
          action.endsWith("/contribute") ||
          action === "/theme" ||
          action === "/mode" ||
          action === "/logout";
        expect(`${path} allows ${action}`).toBe(
          allowed ? `${path} allows ${action}` : `${path} allows nothing`,
        );
      }
      // No composer, no state machine, no labels form, no settings tab.
      expect(html).not.toContain("Comment</button>");
      expect(html).not.toContain(`${browse}/settings`);
      expect(html).not.toContain("Merge pull request");
      expect(html).not.toContain("New issue");
    }
  });

  test("tree, blob and raw all read through the origin", async () => {
    const tree = await bodyOf(alice, `${browse}/tree/main/src`);
    expect(tree).toContain("index.ts");
    const blob = await bodyOf(alice, `${browse}/blob/main/src/index.ts`);
    expect(blob).toContain("export");
    expect(blob).toContain("gears");
    const raw = await asUser(alice, `${browse}/raw/main/src/index.ts`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toStartWith("text/plain");
    // A file in a repository can never execute as a page on this origin.
    expect(raw.headers.get("content-security-policy")).toContain("sandbox");
    expect(await raw.text()).toBe(SOURCE_FILE);
  });

  test("a live browse gets the same explorer column the workbench does", async () => {
    const blob = await bodyOf(alice, `${browse}/blob/main/src/index.ts`);
    expect(blob).toContain('class="explorer"');
    expect(blob).toContain('class="code-layout"');
    // The spine is expanded on the origin's tree, with origin URLs under it.
    expect(blob).toContain(`href="${browse}/blob/main/src/index.ts"`);
    expect(blob).toContain('data-path="src"');
    expect(blob).toContain('id="code-pane"');
    // And the finder is pointed at the origins twin of the paths route.
    expect(blob).toContain(`data-paths="${browse}/paths/main"`);
  });

  test("a file page is two panes with one divider, on the wide shell", async () => {
    const blob = await bodyOf(alice, `${browse}/blob/main/src/index.ts`);
    // The divider is a real separator with a value, between the tree and the
    // file in the DOM — so it is in the tab order between them too.
    expect(blob).toContain('role="separator"');
    expect(blob).toContain('aria-orientation="vertical"');
    expect(blob).toContain('aria-valuemin="200"');
    expect(blob).toContain('aria-valuenow="300"');
    const tree = blob.indexOf('class="explorer"');
    const split = blob.indexOf("data-split");
    const main = blob.indexOf('id="code-main"');
    expect(tree).toBeGreaterThan(0);
    expect(split).toBeGreaterThan(tree);
    expect(main).toBeGreaterThan(split);
    // The code browser lets go of the reading width; other pages keep it.
    expect(blob).toContain('class="shell shell-wide"');
    const home = await bodyOf(alice, browse);
    expect(home).not.toContain("shell-wide");
  });

  test("hovering a file warms the cache and changes nothing on screen", () => {
    // No mouse handler at all, and the pointer handler only calls warm.
    expect(codeJs).not.toMatch(/mouse(over|enter)/);
    const hover = /addEventListener\('pointerover',([\s\S]*?)\n {2}\}\);/.exec(
      codeJs,
    );
    expect(hover).not.toBeNull();
    expect(hover![1]).toContain("warm(a)");
    expect(hover![1]).not.toMatch(/show\(|innerHTML|pushState|location/);
    // warm fetches into the cache and touches neither the pane nor history.
    const warm = /function warm\(link\) \{([\s\S]*?)\n {2}\}/.exec(codeJs);
    expect(warm).not.toBeNull();
    expect(warm![1]).toContain("fetch(");
    expect(warm![1]).toContain("remember(");
    expect(warm![1]).not.toMatch(/innerHTML|pushState|location|aria-current/);
    // Focus (j/k) warms too; only a click opens, and the address follows.
    const focus = /addEventListener\('focusin',([\s\S]*?)\n {2}\}\);/.exec(
      codeJs,
    );
    expect(focus![1]).toContain("warm(a)");
    expect(focus![1]).not.toContain("show(");
    expect(codeJs).toContain("history.pushState({ code: url }, '', url)");
    expect(codeJs).toContain("addEventListener('popstate'");
  });

  test("a live blob offers Mirror to edit, never Edit", async () => {
    const blob = await bodyOf(alice, `${browse}/blob/main/src/index.ts`);
    expect(blob).toContain("Mirror to edit");
    expect(blob).not.toContain(`${browse}/edit/`);
  });

  test("the origins paths route answers for the account that connected it", async () => {
    const mine = await asUser(alice, `${browse}/paths/main`);
    expect(mine.status).toBe(200);
    const listed = (await mine.json()) as { paths: string[] };
    expect(listed.paths).toContain("src/index.ts");
    expect(listed.paths).toContain("README.md");

    // Somebody else's connected account does not exist for you.
    const theirs = await asUser(bob, `${browse}/paths/main`);
    expect(theirs.status).toBe(404);
    const anon = await asUser("", `${browse}/paths/main`);
    expect(anon.status).toBe(404);
  });

  test("the origins branches page reads live and offers no verbs", async () => {
    const html = await bodyOf(alice, `${browse}/branches`);
    expect(html).toContain(">main<");
    expect(html).toContain("Default");
    // Read-only means read-only: no create form, no delete, no new pull.
    expect(html).not.toContain("Create a branch");
    expect(html).not.toContain("/branches/main/delete");
    // The banner still says where the bytes came from.
    expect(html).toContain("Reading live from");
    // A live-browse origin has no local repo to open an SSE stream against.
    expect(html).not.toContain("new EventSource");
  });

  test("commits and one commit render live, with the origin's author", async () => {
    const list = await bodyOf(alice, `${browse}/commits`);
    expect(list).toContain("first");
    expect(list).toContain("Mona Lisa");
    // The banner rides every page, the commit list included.
    expect(list).toContain("Reading live from");

    const oid = /\/commit\/([0-9a-f]{7,40})/.exec(list)?.[1] ?? "";
    expect(oid).not.toBe("");
    const one = await bodyOf(alice, `${browse}/commit/${oid}`);
    expect(one).toContain("the body of it");
    expect(one).toContain("README.md");
    expect(one).toContain("mona");
  });

  test("issues, one issue with its comments, and pulls all render live", async () => {
    const list = await bodyOf(alice, `${browse}/issues`);
    expect(list).toContain("The gear slips");
    expect(list).toContain("mona");
    expect(list).toContain("bug");

    // The filter bar is §5's `.bar`; the page-local `.filters` is gone.
    expect(list).not.toMatch(/class="[^"]*\bfilters\b/);
    expect(list).toMatch(
      /<form class="bar" method="get" action="[^"]*\/issues" role="search">/,
    );
    for (const word of ["Open", "Closed", "All", "Search"])
      expect(list).toContain(word);
    expect(list).toContain('name="q"');

    const one = await bodyOf(alice, `${browse}/issues/7`);
    expect(one).toContain("The gear slips");
    expect(one).toContain("under load");
    expect(one).toContain("seen it too");
    expect(one).toContain("view on origin");
    expect(one).toContain('class="page-head"');
    expect(one).not.toContain("issue-head");
    expect(one).not.toContain("issue-meta");

    const pulls = await bodyOf(alice, `${browse}/pulls`);
    expect(pulls).toContain("Tighten the bolt");
    const pull = await bodyOf(alice, `${browse}/pulls/9`);
    expect(pull).toContain("tighten");
    expect(pull).toContain('class="page-head-sub bar muted small"');
    // A live pull is merged where it lives, and the box says where.
    expect(pull).toContain("Merge on");
  });

  test("a live pull's merge box is §5's card and row, with no merge-* class", async () => {
    const pull = await bodyOf(alice, `${browse}/pulls/9`);
    expect(pull).not.toMatch(/\bmerge-(?:box|form|headline|sub)\b/);
    const box =
      (pull.match(/<div\s+class="card mt"[^>]*data-tone="attn"[\s\S]*?<\/ul>/)?.[0] ?? "")
        .replace(/\s+/g, " ");
    expect(box).toContain('<ul class="list setting-list">');
    expect(box).toContain(`class="row-title" >Merge on ${new URL(fake.url).host}.</span`);
    expect(box).toContain(
      "You are reading this pull request live. Merging, reviewing and commenting all happen where it lives — mirror the repository and comments come back through this forge instead.",
    );
    expect(box).toContain('class="row-trail"');
    expect(box).toContain("Open on the origin");
    expect(box).not.toContain("<form");
  });

  // ---- the where strip ----

  test("a live browse shows origin filled, workbench and machine hollow", async () => {
    const html = await bodyOf(alice, browse);
    const strip = stripOf(html);
    expect(strip).toContain(new URL(fake.url).host);
    expect(strip).toContain("workbench");
    expect(strip).toContain("this machine");
    // The origin is the one being read; the other two are not here.
    expect(strip).toContain('data-state="reading"');
    expect(count(strip, 'data-state="absent"')).toBe(2);
  });

  test("a native repository names two places, not three", async () => {
    await asUser(alice, "/new", {
      form: { name: "native", visibility: "public" },
    });
    const strip = stripOf(await bodyOf(alice, "/alice/native"));
    expect(strip).toContain("workbench");
    expect(strip).toContain("this machine");
    expect(strip).not.toContain(new URL(fake.url).host);
    expect(strip).not.toContain(new URL(originServers.url).host);
    // Reading from the workbench; not on this machine yet.
    expect(count(strip, 'data-state="reading"')).toBe(1);
    expect(count(strip, 'data-state="absent"')).toBe(1);
  });

  // ---- mirroring, as a job with progress ----

  test("Mirror from a browse lands on a job page with a live checklist", async () => {
    const started = await asUser(alice, `${browse}/mirror`, { form: {} });
    expect(started.status).toBe(303);
    const jobPath = started.headers.get("location") ?? "";
    expect(jobPath).toStartWith(`/settings/origins/${originId}/mirror/`);

    const running = await bodyOf(alice, jobPath);
    // Every stage, in the order they happen.
    for (const stage of [
      "Creating the repository",
      "Fetching every branch and tag",
      "Importing labels",
      "Importing issues",
      "Importing pull requests",
      "Importing comments",
    ]) {
      expect(running).toContain(stage);
    }
    // The no-JavaScript half: a plain Reload link, never a meta refresh.
    expect(running).not.toContain("http-equiv");
    expect(running).toContain(">Reload</a>");
    // The enhancement is a static script under the strict CSP — the job it
    // watches arrives as a data attribute, never interpolated into the code.
    expect(running).toContain(
      `data-stream="/api/v1/user/origins/${originId}/mirror/`,
    );
    expect(await pageScriptOf(base, running)).toContain("new EventSource(url)");
    // Each stage is a §5 row with a state badge, never a bare glyph.
    expect(running).not.toContain("stage-dot");
    expect(running).not.toContain("stage-detail");
    expect(running).toMatch(/<ol\s+class="list stages"\s+aria-live="polite"/);
    expect(count(running, "<li data-stage-name=")).toBe(7);
    expect(running).toMatch(/<li data-stage-name="creating" data-state="(?:done|now)">\s*<div class="row"/);
    expect(running).toMatch(/class="badge"\s+data-variant="(?:success|attn|outline)"\s*>(?:Done|Running|Waiting)</);
    // The live update is built from the same table the markup is.
    expect(mirrorJs).toContain(STAGE_BADGE_JS);
    for (const b of Object.values(STAGE_BADGE)) expect(STAGE_BADGE_JS).toContain(b.text);
    expect(running).toMatch(/<script src="\/assets\/page-[0-9a-f]+\.js" defer>/);
    expect(running).not.toMatch(/<script[^>]*src="(?!\/assets\/(?:shell|beacon|page)-)/);

    const done = await settled(jobPath.split("/").pop()!);
    expect(done?.stage).toBe("done");

    const after = await bodyOf(alice, jobPath);
    expect(after).toContain("Done");
    expect(after).toContain("Open the mirror");
    // Finished: a page that stands, with a link to the mirror.
    expect(after).not.toContain("http-equiv");
    expect(after).toContain('href="/alice/widgets"');
  });

  test("after the mirror, the workbench is where the page reads from", async () => {
    const strip = stripOf(await bodyOf(alice, "/alice/widgets"));
    // A mirror names the forge its own page lives on.
    expect(strip).toContain(new URL(originServers.url).host);
    expect(strip).toContain("workbench");
    // Reading locally now, with the origin still present behind it.
    expect(strip).toContain('data-state="reading"');
    expect(strip).toContain('data-state="present"');

    // And the live browse of the same repo now points at the mirror.
    const live = await bodyOf(alice, browse);
    expect(live).toContain('href="/alice/widgets"');
    expect(live).toContain("Open the mirror");
  });

  test("pinning fills the third place with a diamond", async () => {
    const pinned = await asUser(alice, "/alice/widgets/pin", {
      form: { pinned: "1" },
    });
    expect(pinned.status).toBe(303);
    const strip = stripOf(await bodyOf(alice, "/alice/widgets"));
    expect(strip).toContain("◆");
    expect(strip).toContain("this machine");
    expect(strip).not.toContain('data-state="absent"');
    // The third place is the toggle, and now offers the way back out.
    expect(strip).toContain("Stop keeping this repository on my machine");
  });

  test("every where trail is drawn from §5's where strip, not where-dot or where-note", async () => {
    // The repository header, the origin picker's mirrored row, the home
    // page's "On your machine" rail and search: each draws a trail.
    const pages = {
      repo: await bodyOf(alice, "/alice/widgets"),
      picker: await bodyOf(alice, `/settings/origins/${originId}/repos`),
      home: await bodyOf(alice, "/feed"),
      search: await bodyOf(alice, "/search?q=widgets"),
    };
    const strip = stripOf(pages.repo);
    expect(strip).toMatch(/<span aria-hidden="true"\s*>◆<\/span/);
    expect(strip).toMatch(/<span class="muted">\(synced [^)]+\)<\/span>/);
    expect(pages.picker).toContain("mirrored as");
    expect(pages.home).toContain("On your machine");
    for (const [name, html] of Object.entries(pages)) {
      expect(`${name}:${html.includes("where-place")}`).toBe(`${name}:true`);
      expect(`${name}:${/where-dot|where-note/.test(html)}`).toBe(`${name}:false`);
    }
  });

  test("starting a mirror that is already running joins it", async () => {
    // The repository is mirrored, so a second start is refused rather than
    // racing — but it must land somewhere that says so, not on a 500.
    const again = await asUser(alice, `${browse}/mirror`, { form: {} });
    expect([303]).toContain(again.status);
  });

  // ---- who may browse ----

  test("another account gets the same 404 a private repository gets", async () => {
    for (const path of [browse, `${browse}/issues`, `${browse}/commits`]) {
      const response = await asUser(bob, path);
      expect(`${path}:${response.status}`).toBe(`${path}:404`);
    }
    // And an anonymous visitor is sent to sign in, not shown an empty page.
    const out = await asUser("", browse);
    expect(out.status).toBe(303);
    expect(out.headers.get("location")).toStartWith("/signin?next=");
  });

  test("a browse needs the account, not a token that merely reads", async () => {
    const user = getUserByName(app.db, "alice")!;
    const ro = createToken(app, user, "reader", "ro");
    const rw = createToken(app, user, "laptop", "rw");
    const admin = createToken(app, user, "deploy", "admin");
    if (!ro.ok || !rw.ok || !admin.ok) throw new Error("token mint failed");

    for (const token of [ro.value.token, rw.value.token]) {
      const denied = await fetch(`${base}${browse}`, {
        headers: { authorization: `Bearer ${token}` },
        redirect: "manual",
      });
      expect(denied.status).toBe(403);
    }
    // An explicit admin token is the documented way in for automation.
    const allowed = await fetch(`${base}${browse}`, {
      headers: { authorization: `Bearer ${admin.value.token}` },
      redirect: "manual",
    });
    expect(allowed.status).toBe(200);
  });

  test("the mirror POST refuses a cross-origin submit", async () => {
    const response = await asUser(alice, `${browse}/mirror`, {
      form: {},
      origin: "https://evil.example",
    });
    expect(response.status).toBe(403);
  });

  test("a job page belonging to another account is not found", async () => {
    const started = await asUser(alice, `${browse}/mirror`, { form: {} });
    const jobPath = started.headers.get("location") ?? "";
    const stolen = await asUser(bob, jobPath);
    expect(stolen.status).toBe(404);
  });
});

/** Just the where strip, so an assertion about it cannot match page chrome. */
function stripOf(html: string): string {
  const at = html.indexOf('class="where"');
  expect(at).toBeGreaterThan(-1);
  // The strip runs from its own element to the tab row that follows the
  // header, so an assertion about it can never match page chrome instead.
  const end = html.indexOf('<nav class="tabs"', at);
  return html.slice(at, end === -1 ? at + 2000 : end);
}

const count = (text: string, needle: string): number =>
  text.split(needle).length - 1;
