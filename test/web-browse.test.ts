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
import { resetConnectLimit } from "../src/actions/origins.ts";
import { createToken } from "../src/actions/users.ts";
import { listOrigins } from "../src/core/origins.ts";
import { listReposByOwner } from "../src/core/repos.ts";
import { getUserByName } from "../src/core/users.ts";
import { settled } from "../src/origins/jobs.ts";
import { forgetProviders } from "../src/origins/providers/index.ts";
import { clearViewCache } from "../src/view/cache.ts";
import { setLogLevel } from "../src/kernel/log.ts";
import { newFakeState, serveFakeForge, type FakeForge } from "./fake-origin.ts";

setLogLevel("error");

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
    await up(
      "/api/v1/users",
      {
        username: ORIGIN_LOGIN,
        email: "octo@upstream.test",
        password: ORIGIN_TOKEN,
      },
      false,
    );
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
    alice = await signUp("alice");
    bob = await signUp("bob");
    resetConnectLimit();
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
    expect(html).toContain("keep it in sync");
    // And the two things it offers instead of the write buttons.
    expect(html).toContain("Mirror into your workbench");
    expect(html).toContain(`Open on ${new URL(fake.url).host}`);
  });

  test("a live browse has no way to write anything on it", async () => {
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
      // The only POST on any of these pages is the mirror. (Theme and sign
      // out are the shell's, on every page in the product.)
      const forms = [...html.matchAll(/<form[\s\S]*?>/g)].map((m) => m[0]);
      const posts = forms
        .filter((tag) => tag.includes('method="post"'))
        .map((tag) => /action="([^"]*)"/.exec(tag)?.[1] ?? "");
      for (const action of posts) {
        const allowed =
          action.endsWith("/mirror") ||
          action === "/theme" ||
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

    const one = await bodyOf(alice, `${browse}/issues/7`);
    expect(one).toContain("The gear slips");
    expect(one).toContain("under load");
    expect(one).toContain("seen it too");
    expect(one).toContain("view on origin");

    const pulls = await bodyOf(alice, `${browse}/pulls`);
    expect(pulls).toContain("Tighten the bolt");
    const pull = await bodyOf(alice, `${browse}/pulls/9`);
    expect(pull).toContain("tighten");
    // A live pull is merged where it lives, and the box says where.
    expect(pull).toContain("Merge on");
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
    // The no-JavaScript half: it refreshes itself while the job runs.
    expect(running).toContain('http-equiv="refresh"');
    // The enhancement is a static script under the strict CSP — the job it
    // watches arrives as a data attribute, never interpolated into the code.
    expect(running).toContain(
      `data-stream="/api/v1/user/origins/${originId}/mirror/`,
    );
    expect(running).toContain("new EventSource(url)");
    expect(running).toMatch(/<script nonce="[^"]+">/);
    expect(running).not.toMatch(/<script[^>]*src=/);

    const done = await settled(jobPath.split("/").pop()!);
    expect(done?.stage).toBe("done");

    const after = await bodyOf(alice, jobPath);
    expect(after).toContain("Done");
    expect(after).toContain("Open the mirror");
    // Finished: no two-second self-refresh, a hop to the mirror instead.
    expect(after).toContain("url=/alice/widgets");
    expect(after).not.toContain('content="2"');
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
    // The header's own toggle now offers the way back out.
    const html = await bodyOf(alice, "/alice/widgets");
    expect(html).toContain("On my machine");
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
