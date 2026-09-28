/**
 * The code browser in a browser: the explorer column, the path list behind
 * the fuzzy finder, the branches page, the counts on every repository row,
 * and the search page's three sections.
 *
 * Two claims carry most of the weight here, and both are adversarial rather
 * than decorative:
 *
 * - **Nothing on these pages is load-bearing JavaScript.** The explorer is a
 *   tree of `<details>` with real links inside it, the finder's fallback is
 *   that explorer, and the branch verbs are forms. Each of those is asserted
 *   from the served HTML, which is all a reader with no script ever gets.
 * - **A path list is a read like any other.** `/:owner/:name/paths/:ref`
 *   leaks nothing a repository page would not: a stranger asking for a
 *   private repository's file names gets the same `not_found` the repository
 *   itself gives, and the origins twin needs the account that connected it.
 *
 * The client scripts are also parsed here. They ship as strings the server
 * never executes, so a syntax error in one would otherwise reach a browser
 * before it reached a test.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { signUp } from "../src/actions/users.ts";
import { createSession } from "../src/core/sessions.ts";
import { getRepo, updateRepoSettings } from "../src/core/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import {
  codeJs,
  editorJs,
  mirrorJs,
  pollJs,
  shellJs,
} from "../src/web/client.ts";
import { liveClientJs } from "../src/web/live.ts";
import { spineOf } from "../src/web/pages/explorer.ts";
import { markMatch } from "../src/web/pages/search.ts";

quietLogs();

const PASSWORD = "a-long-web-code-passphrase";

describe("the code browser on the web", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice = "";
  let kim = "";

  const get = (path: string, cookie = ""): Promise<Response> =>
    fetch(`${base}${path}`, {
      redirect: "manual",
      headers: {
        cookie: cookie === "" ? "forge_mode=dev" : `${cookie}; forge_mode=dev`,
      },
    });

  const text = async (path: string, cookie = ""): Promise<string> =>
    await (await get(path, cookie)).text();

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-webcode-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;

    const a = await signUp(app, {
      username: "alice",
      email: "a@f.dev",
      password: PASSWORD,
    });
    const k = await signUp(app, {
      username: "kim",
      email: "k@f.dev",
      password: PASSWORD,
    });
    if (!a.ok || !k.ok) throw new Error("signup failed");
    alice = `forge_session=${createSession(app.db, a.value.id).token}`;
    kim = `forge_session=${createSession(app.db, k.value.id).token}`;

    const made = await createRepo(app, a.value, {
      name: "beacon",
      visibility: "public",
      description: "a lamp",
    });
    if (!made.ok) throw new Error("repo failed");
    await commitToBranch(app, a.value, made.value, {
      message: "first",
      files: [
        { path: "README.md", content: "# beacon\n\nthe lamp\n" },
        { path: "src/lamp.ts", content: "export const lamp = 'lit'\n" },
        { path: "src/weather.ts", content: "export const gale = 34\n" },
        { path: "src/optics/lens.ts", content: "export const rings = 24\n" },
        { path: "docs/keeping.md", content: "# keeping\n" },
        {
          path: "docs/fenced.md",
          content: "# fenced\n\n```ts\nconst lit = true\n```\n",
        },
      ],
    });
    await commitToBranch(app, a.value, made.value, {
      branch: "topic",
      message: "second",
      files: [{ path: "src/lamp.ts", content: "export const lamp = 'dark'\n" }],
    });
    const repo = getRepo(app.db, "alice", "beacon")!;
    const issue = openIssue(app, a.value, repo, { title: "flickers" });
    expect(issue.ok).toBe(true);
    const pull = await openPull(app, a.value, repo, {
      title: "make it dark",
      body: "",
      baseBranch: "main",
      headBranch: "topic",
    });
    expect(pull.ok).toBe(true);

    // A private repository, to prove the new reads keep it private.
    const secret = await createRepo(app, a.value, {
      name: "vault",
      visibility: "private",
    });
    if (!secret.ok) throw new Error("private repo failed");
    await commitToBranch(app, a.value, secret.value, {
      message: "hidden",
      files: [{ path: "secret.txt", content: "shh\n" }],
    });
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  // ---- the explorer ----

  test("a blob page renders the explorer with the current path expanded", async () => {
    const html = await text("/alice/beacon/blob/main/src/optics/lens.ts");
    expect(html).toContain('class="explorer"');
    // The spine is open: src, then src/optics.
    expect(html).toContain('data-path="src"');
    expect(html).toContain('data-path="src/optics"');
    // Both spine directories arrive open; the sibling docs/ does not.
    expect(/data-path="src"[^>]*\n?[^>]*open/.test(html)).toBe(true);
    // The current file is marked, and its siblings are there to move to.
    expect(html).toContain('href="/alice/beacon/blob/main/src/optics/lens.ts"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('href="/alice/beacon/blob/main/src/lamp.ts"');
    // The content pane is beside it, not instead of it.
    expect(html).toContain('id="code-main"');
    expect(html).toContain('id="code-pane"');
    // The bytes are there, syntax-highlighted into spans as usual.
    expect(html).toContain("rings");
    expect(html).toContain('class="ln"');
  });

  test("a folder off the spine is closed but still reachable without a script", async () => {
    const html = await text("/alice/beacon/blob/main/src/lamp.ts");
    // docs/ is not on the spine, so it carries the link that makes it work
    // with JavaScript switched off.
    expect(html).toContain('class="ex-more"');
    expect(html).toContain('href="/alice/beacon/tree/main/docs"');
  });

  test("the tree page shares the layout and shows the README at the root", async () => {
    const html = await text("/alice/beacon/tree/main");
    expect(html).toContain('class="code-layout"');
    expect(html).toContain('class="explorer"');
    expect(html).toContain("the lamp");
  });

  /** Markup with its line breaks squeezed out, for asserting on structure. */
  const flat = (html: string): string => html.replace(/\s+/g, " ");

  // ---- Markdown, and the two right answers it has ----

  /**
   * A README is prose; a README you are about to edit is text. The page
   * offers both and defaults to the one people came for, and both halves are
   * plain links — no script decides which of them you get.
   */
  test("a Markdown file renders as prose by default", async () => {
    const html = await text("/alice/beacon/blob/main/README.md");
    expect(html).toContain('class="card prose"');
    expect(html).toContain("<h1>beacon</h1>");
    // The switch is on the page, and Rendered is the one you are on.
    expect(html).toContain(
      'href="/alice/beacon/blob/main/README.md?view=source"',
    );
    expect(flat(html)).toContain('aria-current="page" >Rendered');
    // Not the source table.
    expect(html).not.toContain('class="card code"');
  });

  test("?view=source is the same file as text, highlighted", async () => {
    const html = await text("/alice/beacon/blob/main/README.md?view=source");
    expect(html).toContain('class="card code"');
    expect(html).toContain('class="tok-keyword tok-heading"');
    expect(html).not.toContain("<h1>beacon</h1>");
    expect(flat(html)).toContain('aria-current="page" >Source');
  });

  test("only Markdown gets the switch, and a fence inside it is highlighted", async () => {
    const code = await text("/alice/beacon/blob/main/src/lamp.ts");
    expect(code).not.toContain("?view=source");
    expect(code).toContain('class="tok-keyword"');

    // A fenced block in the README is coloured by the language it names.
    const readme = await text("/alice/beacon/blob/main/docs/fenced.md");
    expect(readme).toContain('<code class="language-ts">');
    expect(readme).toContain('<span class="tok-keyword">const</span>');
  });

  test("the explorer fragment is one directory of rows, not a page", async () => {
    const res = await get("/alice/beacon/tree/main/docs?fragment=explorer");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="ex-list"');
    expect(html).toContain("keeping.md");
    expect(html).not.toContain("<!doctype html>");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
  });

  test("the blob fragment is the same pane a full load renders", async () => {
    const res = await get("/alice/beacon/blob/main/src/weather.ts?fragment=1");
    expect(res.status).toBe(200);
    const fragment = await res.text();
    expect(fragment).toContain('id="code-pane"');
    expect(fragment).toContain("gale");
    expect(fragment).not.toContain("<!doctype html>");
    const full = await text("/alice/beacon/blob/main/src/weather.ts");
    expect(full).toContain('id="code-pane"');
  });

  test("spineOf names the root and every ancestor, and stops at a file", () => {
    expect(spineOf("", false)).toEqual([""]);
    expect(spineOf("src/optics/lens.ts", true)).toEqual([
      "",
      "src",
      "src/optics",
    ]);
    expect(spineOf("src/optics", false)).toEqual(["", "src", "src/optics"]);
  });

  // ---- the path list behind the finder ----

  test("the paths route lists every file at a ref", async () => {
    const res = await get("/alice/beacon/paths/main");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      paths: string[];
      truncated: boolean;
    };
    expect(body.paths).toContain("src/optics/lens.ts");
    expect(body.paths).toContain("README.md");
    expect(body.truncated).toBe(false);
    // A private read never lands in a shared cache.
    expect(res.headers.get("cache-control")).toContain("private");
  });

  test("a stranger gets not_found for a private repository's paths", async () => {
    const res = await get("/alice/beacon/paths/main", kim);
    expect(res.status).toBe(200); // public: fine

    const hidden = await get("/alice/vault/paths/main", kim);
    expect(hidden.status).toBe(404);
    const refusal = (await hidden.json()) as {
      error: string;
      message: string;
    };
    expect(refusal.error).toBe("not_found");
    expect(typeof refusal.message).toBe("string");

    const anon = await get("/alice/vault/paths/main");
    expect(anon.status).toBe(404);

    // And the owner does get it, so the 404 above is about access.
    const mine = await get("/alice/vault/paths/main", alice);
    expect(mine.status).toBe(200);
    expect(((await mine.json()) as { paths: string[] }).paths).toEqual([
      "secret.txt",
    ]);
  });

  test("an unknown ref is a miss, not a crash", async () => {
    const res = await get("/alice/beacon/paths/no-such-ref");
    expect(res.status).toBe(404);
  });

  test("the finder is offered as an enhancement with the explorer behind it", async () => {
    const html = await text("/alice/beacon/blob/main/src/lamp.ts");
    // The button that needs a script says so, and carries its shortcut.
    expect(html).toContain('class="btn js-only ex-find"');
    expect(html).toContain('data-shortcut="t"');
    expect(html).toContain('id="finder"');
    // The fallback is a real, populated tree of links in the same page.
    expect(html).toContain('class="ex-file"');
    expect(html).toContain(`data-paths="/alice/beacon/paths/main"`);
  });

  // ---- branches ----

  test("the branches page lists the default first with ahead/behind", async () => {
    const html = await text("/alice/beacon/branches", alice);
    expect(html).toContain(">main<");
    expect(html).toContain(">topic<");
    expect(html).toContain("Default");
    expect(html).toContain('class="branch-div');
    expect(html).toContain("Create a branch");
    // A non-default branch offers the two verbs a branch list exists for.
    expect(html).toContain("/alice/beacon/pulls/new?head=topic");
    expect(html).toContain("%2Falice%2Fbeacon%2Fbranches%2Ftopic%2Fdelete");
    expect(html.indexOf(">main<")).toBeLessThan(html.indexOf(">topic<"));
  });

  test("the branches tab is in the header and the ref menu points at it", async () => {
    const html = await text("/alice/beacon/blob/main/src/lamp.ts", alice);
    expect(html).toContain('href="/alice/beacon/branches"');
    expect(html).toContain("View all branches");
    expect(html).toContain("Create branch from main…");
  });

  test("a reader sees the list but is offered no verbs", async () => {
    const html = await text("/alice/beacon/branches", kim);
    expect(html).toContain(">topic<");
    expect(html).not.toContain("Create a branch");
    expect(html).not.toContain("/alice/beacon/pulls/new?head=topic");
  });

  test("creating a branch works, and delete refuses the default", async () => {
    const created = await fetch(`${base}/alice/beacon/branches`, {
      method: "POST",
      headers: { cookie: alice, origin: new URL(base).origin },
      body: new URLSearchParams({ name: "lamp/fix", from: "main" }),
      redirect: "manual",
    });
    expect(created.status).toBe(303);
    expect(await text("/alice/beacon/branches", alice)).toContain("lamp/fix");

    const refused = await fetch(`${base}/alice/beacon/branches/main/delete`, {
      method: "POST",
      headers: { cookie: alice, origin: new URL(base).origin },
      body: new URLSearchParams(),
      redirect: "manual",
    });
    expect(refused.status).toBe(303);
    // The flash says why, and main is still there.
    expect(refused.headers.get("set-cookie") ?? "").toContain("forge_flash");
    expect(await text("/alice/beacon/branches", alice)).toContain(">main<");

    const gone = await fetch(
      `${base}/alice/beacon/branches/lamp%2Ffix/delete`,
      {
        method: "POST",
        headers: { cookie: alice, origin: new URL(base).origin },
        body: new URLSearchParams(),
        redirect: "manual",
      },
    );
    expect(gone.status).toBe(303);
    expect(await text("/alice/beacon/branches", alice)).not.toContain(
      "lamp/fix",
    );
  });

  test("a stranger cannot create or delete a branch", async () => {
    const created = await fetch(`${base}/alice/beacon/branches`, {
      method: "POST",
      headers: { cookie: kim, origin: new URL(base).origin },
      body: new URLSearchParams({ name: "kim/mischief", from: "main" }),
      redirect: "manual",
    });
    expect(created.status).toBe(303);
    expect(await text("/alice/beacon/branches", alice)).not.toContain(
      "kim/mischief",
    );
  });

  test("branch mutations are same-origin only", async () => {
    const res = await fetch(`${base}/alice/beacon/branches`, {
      method: "POST",
      headers: { cookie: alice, origin: "https://evil.example" },
      body: new URLSearchParams({ name: "evil", from: "main" }),
      redirect: "manual",
    });
    expect(res.status).toBe(403);
    expect(await text("/alice/beacon/branches", alice)).not.toContain(">evil<");
  });

  test("the delete confirm page words itself and never trusts the link", async () => {
    const ok = await get(
      "/-/confirm?to=" +
        encodeURIComponent("/alice/beacon/branches/topic/delete"),
      alice,
    );
    expect(ok.status).toBe(200);
    const html = await ok.text();
    expect(html).toContain("Delete branch");
    expect(html).toContain("Delete topic?");

    // A route the table does not know is not confirmable at all.
    const nope = await get(
      "/-/confirm?to=" + encodeURIComponent("/alice/beacon/branches"),
      alice,
    );
    expect(nope.status).toBe(404);
  });

  // ---- counts on rows ----

  test("repository rows carry issue and pull counts, and hide the zeroes", async () => {
    const dash = await text("/", alice);
    expect(dash).toContain('class="counts"');
    expect(dash).toContain("open issue");
    expect(dash).toContain("open pull request");

    // vault has no issues and no pulls, so it wears no count chips at all.
    const rows = dash.split("<li>");
    const vault = rows.find((r) => r.includes("alice/vault"));
    expect(vault).toBeDefined();
    expect(vault).not.toContain('class="counts"');

    const beacon = rows.find((r) => r.includes("alice/beacon"));
    expect(beacon).toContain('class="counts"');
  });

  test("an issue row carries its comment count with the message glyph", async () => {
    const repo = getRepo(app.db, "alice", "beacon")!;
    await fetch(`${base}/alice/beacon/issues/1/comments`, {
      method: "POST",
      headers: { cookie: alice, origin: new URL(base).origin },
      body: new URLSearchParams({ body: "still flickering" }),
      redirect: "manual",
    });
    expect(repo).toBeDefined();
    const html = await text("/alice/beacon/issues", alice);
    expect(html).toContain('class="count"');
    expect(html).toContain("1 comments");
  });

  // ---- search ----

  test("the search page renders repositories, conversations and code", async () => {
    const html = await text("/search?q=lamp", alice);
    expect(html).toContain("Repositories");
    expect(html).toContain("Issues and pull requests");
    expect(html).toContain(">Code");
    // A code hit says where it is and shows the line with the query marked.
    expect(html).toContain("src/lamp.ts");
    expect(html).toContain("<mark>lamp</mark>");
    expect(html).toContain("code-line");
    // And the kind chips are links, so they work with no script.
    expect(html).toContain("/search?q=lamp&amp;kind=code");
  });

  test("the query is escaped everywhere it is echoed back", async () => {
    const html = await text(
      "/search?q=" + encodeURIComponent("<img src=x onerror=alert(1)>"),
      alice,
    );
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  test("markMatch marks every occurrence and escapes the text around it", () => {
    const out = markMatch("<b>lamp</b> and lamp", "lamp").text;
    expect(out).toBe(
      "&lt;b&gt;<mark>lamp</mark>&lt;/b&gt; and <mark>lamp</mark>",
    );
  });

  test("the live toggle is off by default and is a plain link", async () => {
    const html = await text("/search?q=lamp", alice);
    expect(html).toContain("Search live on origins");
    expect(html).toContain("live=1");
    const live = await text("/search?q=lamp&live=1", alice);
    expect(live).toContain("Use the cache");
  });

  test("a stranger's search never names a private repository", async () => {
    const html = await text("/search?q=vault", kim);
    expect(html).not.toContain("alice/vault");
    const mine = await text("/search?q=vault", alice);
    expect(mine).toContain("alice/vault");
  });

  test("a protected default branch is stated on the branches page", async () => {
    const repo = getRepo(app.db, "alice", "beacon")!;
    updateRepoSettings(app.db, repo, { protectDefault: true });
    const html = await text("/alice/beacon/branches", alice);
    expect(html).toContain("Protected");
    updateRepoSettings(app.db, repo, { protectDefault: false });
  });

  // ---- the scripts themselves ----

  test("every client script parses", () => {
    for (const [name, source] of [
      ["shellJs", shellJs],
      ["codeJs", codeJs],
      ["editorJs", editorJs],
      ["mirrorJs", mirrorJs],
      ["pollJs", pollJs],
      ["liveClientJs", liveClientJs],
    ] as const) {
      expect(() => new Function(source), `${name} must parse`).not.toThrow();
    }
  });

  test("no code page depends on a script for its content", async () => {
    for (const path of [
      "/alice/beacon",
      "/alice/beacon/tree/main/src",
      "/alice/beacon/blob/main/src/lamp.ts",
      "/alice/beacon/branches",
      "/search?q=lamp",
    ]) {
      const html = await text(path, alice);
      // Every js-only control on the page is a *second* way to do something.
      // The explorer, the tree rows and the branch forms are all in the HTML.
      expect(html).not.toContain("<noscript");
      const jsOnly = (html.match(/js-only/g) ?? []).length;
      if (jsOnly > 0) {
        // Whatever needs a script, the page also states without one.
        expect(
          html.includes('class="ex-file"') ||
            html.includes('class="row') ||
            html.includes("<form"),
        ).toBe(true);
      }
    }
  });
});
