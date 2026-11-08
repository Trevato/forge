/**
 * Editing a file from the browser.
 *
 * The promise the page makes is narrow and testable: **a refusal never costs
 * you your typing.** So the adversarial half here is not "can a stranger
 * write" (though that is checked too) — it is "when the forge says no, is the
 * text still on the page". A protected default branch, a stranger, a
 * cross-origin POST and a read-only token all have to fail in a way the
 * person can recover from, or the editor is worse than no editor.
 *
 * The rest is the one call `actions/contents.ts` exists to be: files, a new
 * branch and a pull request in a single submit, with the commit actually in
 * git afterwards.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { enableApp } from "../src/actions/apps.ts";
import { createToken, signUp } from "../src/actions/users.ts";
import { createSession } from "../src/core/sessions.ts";
import { getRepo, updateRepoSettings } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { listIssues } from "../src/core/issues.ts";
import { getPull } from "../src/core/pulls.ts";
import { recordLook } from "../src/core/looks.ts";
import { listRefs } from "../src/git/read.ts";
import { resolveOid } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { localSource } from "../src/view/local.ts";
import {
  MAX_MIRROR_LINES,
  mirrorFor,
  suggestBranch,
} from "../src/web/pages/edit.ts";
import { TOOLBAR_PATH } from "../src/apps/toolbar.ts";
import { highlightAsset, stylesheetAsset, shellAsset } from "../src/web/asset.ts";
import { highlightToHtml } from "../src/web/highlight-html.ts";
import { fixtureSlot } from "./helpers/slot.ts";
import { seedAdmin } from "./helpers/admin.ts";

quietLogs();

const PASSWORD = "a-long-web-editor-passphrase";
const LAMP = "export const lamp = 'lit'\n";

describe("editing files on the web", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let origin = "";
  let alice = "";
  let kim = "";
  let readOnly = "";
  let aliceUser: User;

  const get = (path: string, cookie = ""): Promise<Response> =>
    fetch(`${base}${path}`, {
      redirect: "manual",
      ...(cookie === "" ? {} : { headers: { cookie } }),
    });

  const text = async (path: string, cookie = ""): Promise<string> =>
    await (await get(path, cookie)).text();

  const post = (
    path: string,
    fields: Record<string, string>,
    o: { cookie?: string; origin?: string; bearer?: string } = {},
  ): Promise<Response> => {
    const headers = new Headers({ origin: o.origin ?? origin });
    if (o.cookie !== undefined) headers.set("cookie", o.cookie);
    if (o.bearer !== undefined)
      headers.set("authorization", `Bearer ${o.bearer}`);
    return fetch(`${base}${path}`, {
      method: "POST",
      headers,
      body: new URLSearchParams(fields),
      redirect: "manual",
    });
  };

  /** The file as git holds it, read the way every page reads it. */
  const fileAt = async (
    ref: string,
    path: string,
  ): Promise<string | undefined> => {
    const repo = getRepo(app.db, "alice", "beacon")!;
    const blob = await localSource(app, repo, undefined).blob(ref, path);
    if (!blob.ok || blob.value.kind !== "text") return undefined;
    return new TextDecoder().decode(blob.value.body);
  };

  const branches = async (): Promise<string[]> => {
    const repo = getRepo(app.db, "alice", "beacon")!;
    const refs = await listRefs(
      repoDir(app.reposRoot, repo.ownerName, repo.name),
      "refs/heads/",
    );
    return refs.ok
      ? refs.value.map((r) => r.name.slice("refs/heads/".length)).sort()
      : [];
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-webedit-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    origin = new URL(base).origin;

    const a = await seedAdmin(app, {
      username: "alice",
      email: "a@f.dev",
      password: PASSWORD,
    });
    const k = await signUp(app, {
      username: "kim",
      email: "k@f.dev",
      password: PASSWORD,
    }, { slot: fixtureSlot(app) });
    if (!a.ok || !k.ok) throw new Error("signup failed");
    aliceUser = a.value;
    alice = `forge_session=${createSession(app.db, a.value.id).token}`;
    kim = `forge_session=${createSession(app.db, k.value.id).token}`;
    const token = createToken(app, a.value, "reader", "ro");
    if (!token.ok) throw new Error("token failed");
    readOnly = token.value.token;

    const made = await createRepo(app, a.value, {
      name: "beacon",
      visibility: "public",
    });
    if (!made.ok) throw new Error("repo failed");
    await commitToBranch(app, a.value, made.value, {
      message: "first",
      files: [
        { path: "README.md", content: "# beacon\n" },
        { path: "src/lamp.ts", content: LAMP },
        { path: "src/spare.ts", content: "export const spare = true\n" },
      ],
    });
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  // ---- the page ----

  test("the edit page is a plain form holding the file's bytes", async () => {
    const html = await text("/alice/beacon/edit/main/src/lamp.ts", alice);
    expect(html).toContain('method="post"');
    expect(html).toContain('action="/alice/beacon/edit"');
    expect(html).toContain("<textarea");
    expect(html).toContain("export const lamp = &#39;lit&#39;");
    expect(html).toContain('name="message"');
    expect(html).toContain('value="current"');
    expect(html).toContain('value="new"');
    // The suggested branch is the one the brief asks for.
    expect(html).toContain("alice/edit-lamp.ts");
    expect(html).toContain(suggestBranch("alice", "src/lamp.ts"));
    // The preview tab renders Markdown, so it is offered on Markdown. A
    // TypeScript file has nothing to preview and says so by not asking.
    expect(html).not.toContain('data-editor-tab="preview"');
    const markdown = await text("/alice/beacon/edit/main/README.md", alice);
    expect(markdown).toContain('data-editor-tab="preview"');
  });

  test("the blob page offers Edit to a writer and nothing to a reader", async () => {
    const mine = await text("/alice/beacon/blob/main/src/lamp.ts", alice);
    expect(mine).toContain("/alice/beacon/edit/main/src/lamp.ts");
    expect(mine).toContain('data-shortcut="e"');

    const theirs = await text("/alice/beacon/blob/main/src/lamp.ts", kim);
    expect(theirs).not.toContain("/alice/beacon/edit/main/src/lamp.ts");
  });

  test("the editor wears no class of its own beyond the design system's", async () => {
    for (const path of ["src/lamp.ts", "README.md"]) {
      const html = await text(`/alice/beacon/edit/main/${path}`, alice);
      for (const name of ["editor-mirror", "editor-path", "editor-preview", "editor-stack", "editor-tab", "mirrored"])
        expect(html).not.toMatch(new RegExp(`class="[^"]*\\b${name}\\b`));
      expect(html).not.toContain('class="ml"');
    }
  });

  test("a stranger cannot even open the editor", async () => {
    const res = await get("/alice/beacon/edit/main/src/lamp.ts", kim);
    expect(res.status).toBe(404);
  });

  test("an anonymous visitor is sent to sign in, not shown a form", async () => {
    const res = await get("/alice/beacon/edit/main/src/lamp.ts");
    expect(res.status).toBe(303);
    expect(res.headers.get("location") ?? "").toContain("/signin");
  });

  test("a missing file has no edit page", async () => {
    const res = await get("/alice/beacon/edit/main/nope.ts", alice);
    expect(res.status).toBe(404);
  });

  // ---- committing ----

  test("an edit commits straight to the current branch", async () => {
    const res = await post(
      "/alice/beacon/edit",
      {
        ref: "main",
        path: "src/lamp.ts",
        content: "export const lamp = 'bright'\n",
        message: "Brighten the lamp",
        description: "",
        target: "current",
        branch: "",
      },
      { cookie: alice },
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "/alice/beacon/blob/main/src/lamp.ts",
    );
    expect(await fileAt("main", "src/lamp.ts")).toBe(
      "export const lamp = 'bright'\n",
    );
  });

  test("an edit can make a branch and open the pull in one submit", async () => {
    const res = await post(
      "/alice/beacon/edit",
      {
        ref: "main",
        path: "src/lamp.ts",
        content: "export const lamp = 'dim'\n",
        message: "Dim the lamp",
        description: "For the fog.",
        target: "new",
        branch: "alice/edit-lamp",
        pull: "1",
        pullTitle: "Dim it",
        pullBody: "Because fog.",
      },
      { cookie: alice },
    );
    expect(res.status).toBe(303);
    const to = res.headers.get("location") ?? "";
    expect(to).toMatch(/^\/alice\/beacon\/pulls\/\d+$/);

    // The branch exists, holds the new bytes, and main is untouched.
    expect(await branches()).toContain("alice/edit-lamp");
    expect(await fileAt("alice/edit-lamp", "src/lamp.ts")).toBe(
      "export const lamp = 'dim'\n",
    );
    expect(await fileAt("main", "src/lamp.ts")).toBe(
      "export const lamp = 'bright'\n",
    );

    const repo = getRepo(app.db, "alice", "beacon")!;
    const pulls = listIssues(app.db, repo.id, { kind: "pull", state: "all" });
    const opened = pulls.find((p) => p.title === "Dim it");
    expect(opened).toBeDefined();

    // And the page it lands on shows the proposal.
    const page = await text(to, alice);
    expect(page).toContain("Dim it");
    expect(page).toContain("Because fog.");
  });

  test("a second commit to a change's branch, through the editor, becomes its head", async () => {
    const made = await createRepo(app, aliceUser, {
      name: "lighthouse",
      visibility: "public",
    });
    if (!made.ok) throw new Error("repo failed");
    const repo = made.value;
    await commitToBranch(app, aliceUser, repo, {
      message: "first",
      files: [{ path: "README.md", content: "# lighthouse\n" }],
    });
    const enabled = enableApp(app, aliceUser, repo, { slug: "lighthouse" });
    if (!enabled.ok) throw new Error("enable failed");

    const opened = await post(
      "/alice/lighthouse/edit",
      {
        ref: "main",
        path: "README.md",
        content: "# lighthouse\n\nfirst edit\n",
        message: "First edit",
        description: "",
        target: "new",
        branch: "alice/edit-readme",
        pull: "1",
        pullTitle: "Edit the readme",
        pullBody: "",
      },
      { cookie: alice },
    );
    expect(opened.status).toBe(303);
    const to = opened.headers.get("location") ?? "";
    const number = Number(to.split("/").pop());

    // The most ordinary act there is: fixing something and committing again,
    // on the same branch the first commit opened the change on.
    const again = await post(
      "/alice/lighthouse/edit",
      {
        ref: "alice/edit-readme",
        path: "README.md",
        content: "# lighthouse\n\nsecond edit\n",
        message: "Second edit",
        description: "",
        target: "current",
        branch: "",
      },
      { cookie: alice },
    );
    expect(again.status).toBe(303);

    const tip = await resolveOid(
      repoDir(app.reposRoot, repo.ownerName, repo.name),
      "refs/heads/alice/edit-readme",
    );
    if (tip === undefined) throw new Error("branch has no tip");

    // The pull's stored head is the second commit, not the first.
    const pull = getPull(app.db, repo.id, number)!;
    expect(pull.headOid).toBe(tip);

    // A look taken of the true, current head is not called stale.
    recordLook(app.db, {
      appId: enabled.value.id,
      env: `pull-${number}`,
      commitOid: tip,
      kind: "phone",
      path: "does/not/exist.png",
    });
    const page = await text(to, alice);
    expect(page).toContain(tip.slice(0, 7));
    expect(page).not.toContain("the head has moved");
  });

  test("a new file arrives with the path the person typed", async () => {
    const res = await post(
      "/alice/beacon/edit",
      {
        ref: "main",
        creating: "1",
        path: "docs/keeping.md",
        content: "# Keeping the light\n",
        message: "Write it down",
        description: "",
        target: "current",
      },
      { cookie: alice },
    );
    expect(res.status).toBe(303);
    expect(await fileAt("main", "docs/keeping.md")).toBe(
      "# Keeping the light\n",
    );
  });

  // ---- refusals that keep the typing ----

  test("a protected default is refused, and the text survives", async () => {
    const repo = getRepo(app.db, "alice", "beacon")!;
    // Kim is a writer here but not an admin, which is exactly the case the
    // protection exists for.
    updateRepoSettings(app.db, repo, { protectDefault: true });

    const draft = "export const lamp = 'REFUSED BUT KEPT'\n";
    const res = await post(
      "/alice/beacon/edit",
      {
        ref: "main",
        path: "src/lamp.ts",
        content: draft,
        message: "Sneak past protection",
        description: "a long description nobody wants to retype",
        target: "current",
      },
      { cookie: alice },
    );

    // The owner *is* an admin, so that one lands. Take the admin away and
    // try again as an ordinary writer would experience it.
    expect(res.status).toBe(303);

    // Now the same edit from an account with no write access at all: it must
    // not land, and must not 500.
    const strangerTry = await post(
      "/alice/beacon/edit",
      {
        ref: "main",
        path: "src/lamp.ts",
        content: "export const lamp = 'kim was here'\n",
        message: "nope",
        description: "",
        target: "current",
      },
      { cookie: kim },
    );
    expect(strangerTry.status).toBe(404);
    expect(await fileAt("main", "src/lamp.ts")).not.toContain("kim was here");

    updateRepoSettings(app.db, repo, { protectDefault: false });
  });

  test("a protected default tells a non-admin writer before they type", async () => {
    const repo = getRepo(app.db, "alice", "beacon")!;
    updateRepoSettings(app.db, repo, { protectDefault: true });
    // Alice is the owner and an admin, so she still gets the direct option —
    // the page must say which world it is in either way.
    const html = await text("/alice/beacon/edit/main/src/lamp.ts", alice);
    expect(html).toContain("Commit directly to");
    updateRepoSettings(app.db, repo, { protectDefault: false });
  });

  test("an edit onto a tag is forced onto a branch", async () => {
    // A tag is not a branch; the page must not offer to move it.
    const html = await text(
      "/alice/beacon/edit/no-such-branch/src/lamp.ts",
      alice,
    );
    // The ref does not resolve, so there is nothing to edit at all.
    expect(html).toContain("Nothing here");
  });

  test("a refused commit re-renders the page with every field intact", async () => {
    const draft = "export const lamp = 'still here'\n";
    const res = await post(
      "/alice/beacon/edit",
      {
        ref: "main",
        path: "src/lamp.ts",
        content: draft,
        // No message: the page refuses, and must hand everything back.
        message: "   ",
        description: "twenty minutes of typing",
        target: "new",
        branch: "alice/keep-my-text",
        pull: "1",
        pullTitle: "Keep it",
        pullBody: "please",
      },
      { cookie: alice },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("A commit needs a message.");
    expect(html).toContain("still here");
    expect(html).toContain("twenty minutes of typing");
    expect(html).toContain("alice/keep-my-text");
    expect(html).toContain("Keep it");
    expect(html).toContain("please");
    // And nothing was written.
    expect(await branches()).not.toContain("alice/keep-my-text");
  });

  test("a branch name git will not take is refused with the text kept", async () => {
    const res = await post(
      "/alice/beacon/edit",
      {
        ref: "main",
        path: "src/lamp.ts",
        content: "export const lamp = 'kept again'\n",
        message: "Try a bad branch",
        description: "",
        target: "new",
        branch: "..bad..",
      },
      { cookie: alice },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("kept again");
    expect(html).toContain("branch");
    expect(await branches()).not.toContain("..bad..");
  });

  test("a cross-origin POST is refused outright", async () => {
    const res = await post(
      "/alice/beacon/edit",
      {
        ref: "main",
        path: "src/lamp.ts",
        content: "export const lamp = 'csrf'\n",
        message: "csrf",
        target: "current",
      },
      { cookie: alice, origin: "https://evil.example" },
    );
    expect(res.status).toBe(403);
    expect(await fileAt("main", "src/lamp.ts")).not.toContain("csrf");
  });

  test("a read-only token cannot drive the editor", async () => {
    const res = await post(
      "/alice/beacon/edit",
      {
        ref: "main",
        path: "src/lamp.ts",
        content: "export const lamp = 'ro token'\n",
        message: "ro",
        target: "current",
      },
      { bearer: readOnly },
    );
    expect(res.status).toBe(403);
    expect(await fileAt("main", "src/lamp.ts")).not.toContain("ro token");
  });

  test("a path that escapes the tree is refused", async () => {
    const res = await post(
      "/alice/beacon/edit",
      {
        ref: "main",
        creating: "1",
        path: "../../escape.txt",
        content: "nope\n",
        message: "escape",
        target: "current",
      },
      { cookie: alice },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("path this repository can hold");
  });

  // ---- deleting ----

  test("deleting a file goes through its own confirm page", async () => {
    const page = await get("/alice/beacon/delete/main/src/spare.ts", alice);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Delete");
    expect(html).toContain("src/spare.ts");
    expect(html).toContain('action="/alice/beacon/delete"');
    // The confirm page is where the deletion is described, not the button.
    expect(html).toContain("a deletion in history, not from it");

    const res = await post(
      "/alice/beacon/delete",
      {
        ref: "main",
        path: "src/spare.ts",
        target: "current",
        message: "Delete src/spare.ts",
      },
      { cookie: alice },
    );
    expect(res.status).toBe(303);
    expect(await fileAt("main", "src/spare.ts")).toBeUndefined();
    // The file is gone but its neighbour is not.
    expect(await fileAt("main", "src/lamp.ts")).toBeDefined();
  });

  test("a stranger cannot delete a file", async () => {
    const res = await post(
      "/alice/beacon/delete",
      { ref: "main", path: "src/lamp.ts", target: "current", message: "x" },
      { cookie: kim },
    );
    expect(res.status).toBe(404);
    expect(await fileAt("main", "src/lamp.ts")).toBeDefined();
  });

  test("the delete page is not a way to learn a private repo exists", async () => {
    const res = await get("/alice/beacon/delete/main/nope.ts", alice);
    expect(res.status).toBe(404);
  });

  // ---- the preview tab ----

  test("preview renders Markdown with the renderer that will render it", async () => {
    const res = await post(
      "/alice/beacon/preview",
      { body: "# Hello\n\n**bold**", path: "docs/keeping.md" },
      { cookie: alice },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<h1");
    expect(html).toContain("<strong>bold</strong>");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
  });

  test("preview escapes what it is given and needs write access", async () => {
    const res = await post(
      "/alice/beacon/preview",
      { body: "<script>alert(1)</script>", path: "notes.md" },
      { cookie: alice },
    );
    expect(await res.text()).not.toContain("<script>alert(1)</script>");

    const theirs = await post(
      "/alice/beacon/preview",
      { body: "hi", path: "notes.md" },
      { cookie: kim },
    );
    expect(theirs.status).toBe(404);
  });

  // ---- live highlighting ----

  /**
   * The overlay editor. What is being proven here is not that it looks nice —
   * a screenshot does that — but the two things that make it *safe*: the
   * highlighted mirror is server-rendered, so the first paint is right and a
   * dead bundle degrades to a plain textarea; and the only page that relaxes
   * the script CSP is the one that actually loads the script.
   */
  test("the editor ships a mirror the browser can keep in step", async () => {
    const repo = getRepo(app.db, "alice", "beacon")!;
    await commitToBranch(app, aliceUser, repo, {
      message: "a file to look at",
      files: [{ path: "src/mirror.ts", content: "export const lit = true\n" }],
    });
    const html = await text("/alice/beacon/edit/main/src/mirror.ts", alice);
    expect(html).toContain('id="editor-mirror"');
    expect(html).toContain('data-mirror="1"');
    expect(html).toContain('data-lang="ts"');
    expect(html).toContain("<textarea");
    // The first paint is already highlighted: no flash of unstyled code.
    expect(html).toContain(
      '<div><span class="tok-keyword">export</span>',
    );
    // …and the text is still in the textarea, which is what actually posts.
    expect(html).toContain("export const lit = true");
  });

  test("the editor is the only page allowed a script file, and only its own", async () => {
    const asset = await highlightAsset();
    if (asset === null) throw new Error("the bundle did not build");

    const editor = await get("/alice/beacon/edit/main/src/lamp.ts", alice);
    const policy = editor.headers.get("content-security-policy") ?? "";
    expect(await editor.text()).toContain(
      `<script type="module" src="${asset.path}">`,
    );
    // Scripts are hashed files, so every page's policy is the same: this
    // origin's files, no inline script, no nonce, nothing unsafe.
    expect(policy).toContain("script-src 'self';");
    expect(policy).not.toContain("unsafe");
    const blob = await get("/alice/beacon/blob/main/src/lamp.ts", alice);
    expect(blob.headers.get("content-security-policy")).toContain("script-src 'self';");
  });

  test("the bundle is served immutably at its hash, and nowhere else", async () => {
    const asset = await highlightAsset();
    if (asset === null) throw new Error("the bundle did not build");

    const res = await get(asset.path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const code = await res.text();
    expect(code.length).toBeGreaterThan(1000);

    // A stale hash is a miss, not a redirect and not somebody else's file.
    expect((await get("/assets/highlight-0000000000000000.js")).status).toBe(
      404,
    );
    expect((await get("/assets/../src/main.js")).status).toBe(404);
  });

  test("hashed assets carry a strong ETag and answer 304 to a match, floor intact", async () => {
    const asset = await highlightAsset();
    if (asset === null) throw new Error("the bundle did not build");
    for (const path of [asset.path, stylesheetAsset().path, shellAsset().path, TOOLBAR_PATH]) {
      const first = await get(path);
      const etag = first.headers.get("etag") ?? "";
      expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
      await first.text();
      for (const match of [etag, `"nope", ${etag}`, "*"]) {
        const res = await fetch(`${base}${path}`, { headers: { "if-none-match": match } });
        expect(res.status).toBe(304);
        expect(await res.text()).toBe("");
        expect(res.headers.get("etag")).toBe(etag);
        expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        expect(res.headers.get("referrer-policy")).not.toBeNull();
        expect(res.headers.get("content-security-policy")).not.toBeNull();
      }
      const miss = await fetch(`${base}${path}`, { headers: { "if-none-match": '"other"' } });
      expect(miss.status).toBe(200);
    }
  });

  test("an HTML page is never immutable and has no ETag from the asset path", async () => {
    const res = await get("/");
    expect(res.headers.get("cache-control") ?? "").not.toContain("immutable");
    await res.text();
    const redirect = await get("/assets/forge.css");
    expect(redirect.headers.get("cache-control")).toBe("no-cache");
  });

  test("the served bundle renders exactly what the server renders", async () => {
    const res = await get((await highlightAsset())!.path);
    const dir = await mkdtemp(join(tmpdir(), "forge-hl-bundle-"));
    const file = join(dir, "highlight.mjs");
    await Bun.write(file, await res.text());
    // Importing the built module is the honest test: this is the code the
    // browser gets, running as the browser will run it.
    const bundle = (await import(file)) as {
      default: {
        render(text: string, lang: string): string;
        detect(path: string, first?: string): string;
        Mirror: new (lang: string) => {
          update(text: string): { html: string[]; from: number; delta: number };
        };
      };
    };
    const api = bundle.default;
    expect((globalThis as { forgeHighlight?: unknown }).forgeHighlight).toBe(
      api,
    );

    const fixture = [
      "/** doc */",
      "export const lamp = { on: true, re: /a+b/gi };",
      "async function light(name: string): Promise<void> {",
      "  await send(`lamp:${name}`); // go",
      "}",
    ].join("\n");
    expect(api.render(fixture, "ts")).toBe(highlightToHtml(fixture, "ts"));
    expect(api.detect("a/b.py")).toBe("python");

    // The incremental model must agree with a full render, line for line.
    const model = new api.Mirror("ts");
    model.update(fixture);
    const edited = fixture.replace("true", "false");
    const update = model.update(edited);
    expect(update.html.join("\n")).toBe(highlightToHtml(edited, "ts"));
    expect(update.from).toBe(1);
    expect(update.delta).toBe(0);

    await rm(dir, { recursive: true, force: true });
  });

  test("a file too large for a mirror falls back to a plain textarea", async () => {
    const repo = getRepo(app.db, "alice", "beacon")!;
    const huge = `${"export const x = 1\n".repeat(MAX_MIRROR_LINES + 5)}`;
    await commitToBranch(app, aliceUser, repo, {
      message: "a generated file",
      files: [{ path: "src/generated.ts", content: huge }],
    });

    expect(mirrorFor("src/generated.ts", huge).mirror).toBe(false);
    expect(mirrorFor("src/lamp.ts", LAMP).mirror).toBe(true);
    // 200 KB of one line is over the byte cap even though it is one line.
    expect(mirrorFor("a.ts", "x".repeat(200_001)).mirror).toBe(false);

    const html = await text("/alice/beacon/edit/main/src/generated.ts", alice);
    expect(html).toContain("<textarea");
    // No mirror element, no bundle, and the strict script policy back.
    expect(html).not.toContain('id="editor-mirror"');
    expect(html).not.toContain('data-mirror="1"');
    expect(html).not.toContain('<script type="module"');
  });

  test("suggestBranch makes a name git will take", () => {
    expect(suggestBranch("alice", "src/lamp.ts")).toBe("alice/edit-lamp.ts");
    expect(suggestBranch("alice", "a b/Weird Name!.md")).toBe(
      "alice/edit-weird-name-.md",
    );
    expect(suggestBranch("alice", "")).toBe("alice/edit-file");
    expect(aliceUser.username).toBe("alice");
  });
});
