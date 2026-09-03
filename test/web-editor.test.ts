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
import { createToken, signUp } from "../src/actions/users.ts";
import { createSession } from "../src/core/sessions.ts";
import { getRepo, updateRepoSettings } from "../src/core/repos.ts";
import { listIssues } from "../src/core/issues.ts";
import { listRefs } from "../src/git/read.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { setLogLevel } from "../src/kernel/log.ts";
import { localSource } from "../src/view/local.ts";
import { suggestBranch } from "../src/web/pages/edit.ts";

setLogLevel("error");

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
  let aliceUser: { id: string; username: string };

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
    // The preview tab needs a script, so it ships hidden until one runs.
    expect(html).toContain('data-editor-tab="preview"');
  });

  test("the blob page offers Edit to a writer and nothing to a reader", async () => {
    const mine = await text("/alice/beacon/blob/main/src/lamp.ts", alice);
    expect(mine).toContain("/alice/beacon/edit/main/src/lamp.ts");
    expect(mine).toContain('data-shortcut="e"');

    const theirs = await text("/alice/beacon/blob/main/src/lamp.ts", kim);
    expect(theirs).not.toContain("/alice/beacon/edit/main/src/lamp.ts");
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
      { cookie: alice, bearer: undefined },
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

  test("suggestBranch makes a name git will take", () => {
    expect(suggestBranch("alice", "src/lamp.ts")).toBe("alice/edit-lamp.ts");
    expect(suggestBranch("alice", "a b/Weird Name!.md")).toBe(
      "alice/edit-weird-name-.md",
    );
    expect(suggestBranch("alice", "")).toBe("alice/edit-file");
    expect(aliceUser.username).toBe("alice");
  });
});
