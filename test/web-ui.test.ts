/**
 * The web shell and its new affordances, exercised against a real server:
 * flash messages, label assignment, closing a pull, deleting a repository,
 * account forms, the palette index, the raw route, and the boundaries that
 * every one of those has to respect (cross-origin, permission, ref safety).
 *
 * These are protocol-level tests on purpose. The adversarial ones — can a
 * stranger see the Settings tab, can a crafted confirm link aim anywhere, can
 * a bad ref reach git — are worth more than the happy paths beside them.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { getUserByName } from "../src/core/users.ts";
import { NEW_ISSUE_KEY, SCRIPT_KEYS } from "../src/web/script_keys.ts";
import { getRepo } from "../src/core/repos.ts";
import { listLabels, labelsFor, getIssue } from "../src/core/issues.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { rawResponse } from "../src/web/pages/repo.ts";
import { safeNext } from "../src/web/pages/site.ts";
import { shellJs } from "../src/web/client.ts";
import { copyField } from "../src/web/ui.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { proveAll } from "./helpers/verified.ts";
import { adminCookie } from "./helpers/admin.ts";

const form = (fields: Record<string, string>) => new URLSearchParams(fields);

describe("web ui", () => {
  let dataDir: string;
  let work: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let owner = "";
  let stranger = "";
  let pullNumber = 0;

  const gitEnv = gitClientEnv({
    GIT_AUTHOR_NAME: "Mel",
    GIT_AUTHOR_EMAIL: "mel@forge.local",
    GIT_COMMITTER_NAME: "Mel",
    GIT_COMMITTER_EMAIL: "mel@forge.local",
  });

  async function git(args: string[], cwd: string): Promise<number> {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      env: gitEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    return await proc.exited;
  }

  async function signup(username: string): Promise<string> {
    const res = await fetch(`${base}/signup`, {
      method: "POST",
      body: form({
        username,
        email: `${username}@f.dev`,
        password: "web-ui-password",
      }),
      redirect: "manual",
    });
    proveAll(app);
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-webui-"));
    work = await mkdtemp(join(tmpdir(), "forge-webui-work-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    owner = await adminCookie(app, { username: "mel", email: "mel@f.dev", password: "web-ui-password" });
    stranger = await signup("kim");

    await fetch(`${base}/new`, {
      method: "POST",
      headers: { cookie: owner },
      body: form({ name: "proj", visibility: "public", description: "a repo" }),
      redirect: "manual",
    });

    // A real repository, so tree/blob/raw/commits have something to render.
    const repo = join(work, "proj");
    await mkdir(repo, { recursive: true });
    await git(["init", "-q", "-b", "main", "."], repo);
    await writeFile(join(repo, "a.txt"), "one\n");
    await git(["add", "."], repo);
    await git(["commit", "-q", "-m", "first"], repo);
    const remote = `http://mel:web-ui-password@localhost:${servers.port}/mel/proj.git`;
    await git(["push", "-q", remote, "main"], repo);
    await git(["checkout", "-q", "-b", "topic"], repo);
    await writeFile(join(repo, "a.txt"), "two\n");
    await git(["commit", "-qam", "second"], repo);
    await git(["push", "-q", remote, "topic"], repo);

    await fetch(`${base}/mel/proj/issues/new`, {
      method: "POST",
      headers: { cookie: owner },
      body: form({ title: "needs a label", body: "" }),
      redirect: "manual",
    });
    await fetch(`${base}/mel/proj/settings/labels`, {
      method: "POST",
      headers: { cookie: owner },
      body: form({ name: "bug", color: "d73a4a" }),
      redirect: "manual",
    });
    const opened = await fetch(`${base}/mel/proj/pulls/new`, {
      method: "POST",
      headers: { cookie: owner },
      body: form({
        base: "main",
        head: "topic",
        title: "second line",
        body: "",
        baseRepo: "self",
      }),
      redirect: "manual",
    });
    pullNumber = Number(
      (opened.headers.get("location") ?? "").split("/").pop(),
    );
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  // ---- flash ----

  test("a mutation flashes once, and rendering it clears the cookie", async () => {
    const posted = await fetch(`${base}/mel/proj/issues/new`, {
      method: "POST",
      headers: { cookie: owner },
      body: form({ title: "flash me", body: "" }),
      redirect: "manual",
    });
    expect(posted.status).toBe(303);
    const setCookie = posted.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("forge_flash=");
    expect(setCookie).toContain("HttpOnly");
    const flash = setCookie.split(";")[0]!;

    const shown = await fetch(`${base}${posted.headers.get("location")}`, {
      headers: { cookie: `${owner}; ${flash}` },
    });
    const html = await shown.text();
    expect(html).toContain('class="toast"');
    expect(html).toContain("opened");
    // Shown exactly once: the page that rendered it also expired the cookie.
    expect(shown.headers.get("set-cookie") ?? "").toContain("forge_flash=;");

    // Without the cookie the same page carries no toast at all.
    const plain = await fetch(`${base}${posted.headers.get("location")}`, {
      headers: { cookie: owner },
    });
    expect(await plain.text()).not.toContain('class="toast"');
  });

  test("a malformed flash cookie is ignored, never rendered", async () => {
    const res = await fetch(base, {
      headers: { cookie: `${owner}; forge_flash=%%%not-json%%%` },
    });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).not.toContain("not-json");
  });

  // ---- labels ----

  test("the labels form applies labels, and they render as chips", async () => {
    const repo = getRepo(app.db, "mel", "proj")!;
    const label = listLabels(app.db, repo.id).find((l) => l.name === "bug")!;
    const res = await fetch(`${base}/mel/proj/issues/1/labels`, {
      method: "POST",
      headers: { cookie: owner },
      body: form({ labels: label.id }),
      redirect: "manual",
    });
    expect(res.status).toBe(303);

    const issue = getIssue(app.db, repo.id, 1)!;
    expect(labelsFor(app.db, issue.id).map((l) => l.name)).toEqual(["bug"]);

    const page = await (
      await fetch(`${base}/mel/proj/issues/1`, { headers: { cookie: owner } })
    ).text();
    expect(page).toContain("lc-d73a4a");
    expect(page).toContain(".lc-d73a4a{--label:#d73a4a}");
    expect(page).toContain(">bug</span>");
    // A colour mixed from the labels on *this* page is what `styleCss` is
    // for, and the only thing left using it: nothing static rides along.
    expect(page).toMatch(/<style>\.lc-d73a4a\{--label:#d73a4a\}<\/style>/);

    // And the list can filter by it.
    const filtered = await (
      await fetch(`${base}/mel/proj/issues?label=bug`)
    ).text();
    expect(filtered).toContain("needs a label");
  });

  test("a stranger cannot apply labels", async () => {
    const res = await fetch(`${base}/mel/proj/issues/1/labels`, {
      method: "POST",
      headers: { cookie: stranger },
      body: form({ labels: "whatever" }),
      redirect: "manual",
    });
    expect(res.status).toBe(303); // a flash explaining the refusal
    const repo = getRepo(app.db, "mel", "proj")!;
    const issue = getIssue(app.db, repo.id, 1)!;
    expect(labelsFor(app.db, issue.id).map((l) => l.name)).toEqual(["bug"]);
  });

  // ---- pull state ----

  test("a pull request closes and reopens from the web", async () => {
    const at = `${base}/mel/proj/pulls/${pullNumber}`;
    await fetch(`${at}/state`, {
      method: "POST",
      headers: { cookie: owner },
      body: form({ state: "closed" }),
      redirect: "manual",
    });
    let page = await (await fetch(at)).text();
    expect(page).toContain('data-state="closed"');
    expect(await (await fetch(`${at}/files`)).text()).toContain(
      "Closed without merging.",
    );
    expect(await (await fetch(`${base}/mel/proj/pulls`)).text()).toContain(
      "No pull request is open.",
    );

    await fetch(`${at}/state`, {
      method: "POST",
      headers: { cookie: owner },
      body: form({ state: "open" }),
      redirect: "manual",
    });
    page = await (await fetch(at)).text();
    expect(page).toContain('data-state="open"');
    expect(await (await fetch(`${at}/files`)).text()).toContain(
      "Ready to merge",
    );
  });

  // ---- permission-shaped chrome ----

  test("the Settings tab is shown to admins and to nobody else", async () => {
    const asOwner = await (
      await fetch(`${base}/mel/proj`, { headers: { cookie: owner } })
    ).text();
    expect(asOwner).toContain('href="/mel/proj/settings"');

    for (const cookie of [stranger, ""]) {
      const html = await (
        await fetch(`${base}/mel/proj`, cookie ? { headers: { cookie } } : {})
      ).text();
      expect(html).not.toContain('href="/mel/proj/settings"');
    }
  });

  // ---- raw ----

  async function revParse(spec: string): Promise<string> {
    const proc = Bun.spawn(["git", "rev-parse", spec], {
      cwd: join(work, "proj"),
      env: gitEnv,
      stdout: "pipe",
    });
    return (await new Response(proc.stdout).text()).trim();
  }

  test("raw at a full commit id is immutable, with the blob oid as ETag and a 304", async () => {
    const commit = await revParse("main");
    const blobOid = await revParse("main:a.txt");
    const url = `${base}/mel/proj/raw/${commit}/a.txt`;
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, s-maxage=86400, immutable",
    );
    expect(res.headers.get("etag")).toBe(`"${blobOid}"`);
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; sandbox",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    await res.text();

    const again = await fetch(url, {
      headers: { "if-none-match": `"${blobOid}"` },
    });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    expect(again.headers.get("cache-control")).toContain("immutable");
  });

  test("raw at a branch name revalidates against the blob oid", async () => {
    const blobOid = await revParse("main:a.txt");
    const res = await fetch(`${base}/mel/proj/raw/main/a.txt`);
    expect(res.headers.get("cache-control")).toBe("private, max-age=0");
    expect(res.headers.get("etag")).toBe(`"${blobOid}"`);
    await res.text();
    const again = await fetch(`${base}/mel/proj/raw/main/a.txt`, {
      headers: { "if-none-match": `"${blobOid}"` },
    });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    const other = await fetch(`${base}/mel/proj/raw/main/a.txt`, {
      headers: { "if-none-match": '"0000"' },
    });
    expect(other.status).toBe(200);
    await other.text();
  });

  test("raw answers 304 to a weak tag, a list holding the tag, and *", () => {
    const oid = "b".repeat(40);
    const blob = {
      kind: "text" as const,
      body: new TextEncoder().encode("x"),
      size: 1,
      oid,
    };
    const ask = (inm: string) =>
      rawResponse(blob, {
        oid,
        immutable: true,
        public: true,
        request: new Request("http://x/", {
          headers: { "if-none-match": inm },
        }),
      }).status;
    expect(ask(`W/"${oid}"`)).toBe(304);
    expect(ask(`"zzz", "${oid}"`)).toBe(304);
    expect(ask("*")).toBe(304);
    expect(ask('"zzz"')).toBe(200);
  });

  test("raw of a repository that is not public is never cached as public", () => {
    const blob = {
      kind: "text" as const,
      body: new TextEncoder().encode("x"),
      size: 1,
      oid: "a".repeat(40),
    };
    const res = rawResponse(blob, {
      oid: blob.oid,
      immutable: true,
      public: false,
    });
    expect(res.headers.get("cache-control")).toBe(
      "private, max-age=31536000, immutable",
    );
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
  });

  test("raw of a private repository at a full commit id is private, over HTTP", async () => {
    await fetch(`${base}/new`, {
      method: "POST",
      headers: { cookie: owner },
      body: form({ name: "hush", visibility: "private" }),
      redirect: "manual",
    });
    const dir = join(work, "hush");
    await mkdir(dir, { recursive: true });
    await git(["init", "-q", "-b", "main", "."], dir);
    await writeFile(join(dir, "s.txt"), "secret\n");
    await git(["add", "."], dir);
    await git(["commit", "-q", "-m", "s"], dir);
    await git(
      [
        "push",
        "-q",
        `http://mel:web-ui-password@localhost:${servers.port}/mel/hush.git`,
        "main",
      ],
      dir,
    );
    const proc = Bun.spawn(["git", "rev-parse", "HEAD"], {
      cwd: dir,
      env: gitEnv,
      stdout: "pipe",
    });
    const commit = (await new Response(proc.stdout).text()).trim();
    const url = `${base}/mel/hush/raw/${commit}/s.txt`;
    const res = await fetch(url, { headers: { cookie: owner } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(
      "private, max-age=31536000, immutable",
    );
    expect(res.headers.get("cache-control")).not.toContain("public");
    await res.text();
    const etag = res.headers.get("etag")!;
    const again = await fetch(url, {
      headers: { cookie: owner, "if-none-match": etag },
    });
    expect(again.status).toBe(304);
    expect(again.headers.get("cache-control")).not.toContain("public");
    expect((await fetch(url)).status).toBe(404);
  });

  test("raw serves bytes as text with nosniff, and conflates not-found", async () => {
    const res = await fetch(`${base}/mel/proj/raw/main/a.txt`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(await res.text()).toBe("one\n");

    // A missing file, a hostile ref and a private repo are all the same 404.
    expect((await fetch(`${base}/mel/proj/raw/main/nope.txt`)).status).toBe(
      404,
    );
    expect(
      (await fetch(`${base}/mel/proj/raw/..%2F..%2Fetc/a.txt`)).status,
    ).toBe(404);

    await fetch(`${base}/new`, {
      method: "POST",
      headers: { cookie: stranger },
      body: form({ name: "secret", visibility: "private" }),
      redirect: "manual",
    });
    const hidden = await fetch(`${base}/kim/secret/raw/main/a.txt`);
    const absent = await fetch(`${base}/kim/nothing/raw/main/a.txt`);
    expect(hidden.status).toBe(404);
    expect(absent.status).toBe(404);
    // Byte-identical once the per-response CSP nonce and the echo of the path
    // the visitor typed (the page's own manifest link, #824) are normalised: a
    // repo you may not see and one that does not exist give the same page.
    const scrub = (t: string) =>
      t
        .replaceAll(/nonce-?="?[\w-]+/g, "nonce")
        .replaceAll(/here\?path=[^"&\s]*/g, "here?path=")
        .replaceAll(/next=[^"]*/g, "next=")
        .replaceAll(/\/new\/issue\?from=[^"]*/g, "/new/issue?from=");
    expect(scrub(await hidden.text())).toBe(scrub(await absent.text()));
  });

  test("a signed-out 404 offers sign-in back to the same address", async () => {
    const asked = "/kim/secret?tab=x&y=1";
    const out = await (await fetch(`${base}${asked}`)).text();
    expect(out).toContain(
      `href="/signin?next=${encodeURIComponent(asked).replaceAll("&", "&amp;")}"`,
    );
    expect(out).toContain('href="/"');
    expect(out).toContain("Go home");
    expect(out).toContain('href="/explore"');
    const hidden = await (await fetch(`${base}/kim/secret`)).text();
    const absent = await (await fetch(`${base}/kim/nothing`)).text();
    const scrub = (t: string) =>
      t.replaceAll(/nonce-?="?[\w-]+/g, "nonce").replaceAll(/here\?path=[^"&\s]*/g, "here?path=").replaceAll(/next=[^"]*/g, "").replaceAll(/\/new\/issue\?from=[^"]*/g, "/new/issue?from=").replaceAll(/q=[^"]*"/g, 'q="').replaceAll(/Search for ‘[^’]*’/g, "Search for");
    expect(scrub(hidden)).toBe(scrub(absent));

    const signedIn = await (
      await fetch(`${base}/kim/nothing`, { headers: { cookie: stranger } })
    ).text();
    expect(signedIn).toContain("Nothing here");
    expect(signedIn).not.toContain("/signin?next=");
    expect(signedIn).toContain("Go home");
    expect(signedIn).toContain('href="/explore"');
  });

  test("the signed-out home links to /pricing in the top bar", async () => {
    const out = await (await fetch(`${base}/`)).text();
    expect(out).toContain('<a class="small" href="/pricing">Pricing</a>');
  });

  test("a 404 offers a search for what was asked, and a stranger an account", async () => {
    const out = await (await fetch(`${base}/kim/nothing`)).text();
    expect(out).toContain('href="/search?q=nothing"');
    expect(out).toContain("Search for ‘nothing’");
    expect(out).toContain('href="/signup"');
    expect(out).toContain("Create an account");

    const odd = await (await fetch(`${base}/%3Cx%3E`)).text();
    expect(odd).toContain("Search for ‘&lt;x&gt;’");
    expect(odd).toContain('href="/search?q=%3Cx%3E"');
    expect(odd).not.toContain("<x>");

    const long = await (await fetch(`${base}/${"a".repeat(150)}`)).text();
    expect(long).toContain(`q=${"a".repeat(100)}"`);

    const signedIn = await (
      await fetch(`${base}/kim/nothing`, { headers: { cookie: stranger } })
    ).text();
    expect(signedIn).toContain("Search for ‘nothing’");
    expect(signedIn).not.toContain("Create an account");
  });

  test("safeNext refuses another origin", () => {
    expect(safeNext("//evil.example/x")).toBeUndefined();
    expect(safeNext("https://evil.example")).toBeUndefined();
    expect(safeNext("/\\evil.example")).toBeUndefined();
    expect(safeNext("/kim/secret?a=1")).toBe("/kim/secret?a=1");
  });

  // ---- ref safety ----

  test("tree and commits refuse a ref that is not a ref", async () => {
    for (const bad of [
      "--upload-pack=touch",
      "..%2F..%2Fetc",
      "main..other",
      "%00main",
    ]) {
      expect((await fetch(`${base}/mel/proj/tree/${bad}`)).status).toBe(404);
    }
    // The commits page falls back to the default branch instead of passing a
    // hostile ?ref= to git.
    const commits = await fetch(`${base}/mel/proj/commits?ref=--output%3Dx`);
    expect(commits.status).toBe(200);
    expect(await commits.text()).toContain("first");

    // A real ref still switches.
    const topic = await fetch(`${base}/mel/proj/commits?ref=topic`);
    expect(await topic.text()).toContain("second");
  });

  // ---- the command palette index ----

  test("the palette index is a data block that cannot close its own script", async () => {
    await fetch(`${base}/new`, {
      method: "POST",
      headers: { cookie: owner },
      body: form({ name: "sc-ript", visibility: "public" }),
      redirect: "manual",
    });
    // The palette's by-name rows are every repository, apps first
    // (`paletteIndex`, `src/web/layout.ts`), so a plain one is there too.
    const html = await (
      await fetch(`${base}/`, { headers: { cookie: owner } })
    ).text();
    const start = html.indexOf(
      '<script type="application/json" id="palette-index">',
    );
    expect(start).toBeGreaterThan(-1);
    const json = html.slice(
      start + '<script type="application/json" id="palette-index">'.length,
      html.indexOf("</script>", start),
    );
    // Every "<" is escaped, so "</script" can never appear inside the block.
    expect(json).not.toContain("<");
    const parsed = JSON.parse(json) as { items: { t: string; h: string }[] };
    expect(parsed.items.some((i) => i.t === "mel/sc-ript")).toBe(true);
    expect(parsed.items.every((i) => i.h.startsWith("/"))).toBe(true);
  });

  // ---- account forms ----

  test("the profile form saves, and rejects a bad email without losing input", async () => {
    const bad = await fetch(`${base}/settings`, {
      method: "POST",
      headers: { cookie: owner },
      body: form({ displayName: "Mel Tester", email: "not-an-email" }),
      redirect: "manual",
    });
    expect(bad.status).toBe(422);
    const html = await bad.text();
    expect(html).toContain("Mel Tester"); // the typed value survives
    expect(html).toContain('class="error"');

    const good = await fetch(`${base}/settings`, {
      method: "POST",
      headers: { cookie: owner },
      body: form({ displayName: "Mel Tester", email: "mel2@f.dev" }),
      redirect: "manual",
    });
    expect(good.status).toBe(303);
    expect(good.headers.get("set-cookie") ?? "").toContain("forge_flash=");
  });

  test("the password form refuses a wrong current password and a mismatch", async () => {
    const wrong = await fetch(`${base}/settings/password`, {
      method: "POST",
      headers: { cookie: owner },
      body: form({
        current: "not-my-password",
        next: "a-longer-password",
        confirm: "a-longer-password",
      }),
      redirect: "manual",
    });
    expect(wrong.status).toBe(422);

    const mismatch = await fetch(`${base}/settings/password`, {
      method: "POST",
      headers: { cookie: owner },
      body: form({
        current: "web-ui-password",
        next: "a-longer-password",
        confirm: "a-different-one",
      }),
      redirect: "manual",
    });
    expect(mismatch.status).toBe(422);
    // Still the old password, so the rest of this suite keeps working.
    const still = await fetch(`${base}/api/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "mel", password: "web-ui-password" }),
    });
    expect(still.status).toBe(201);
  });

  // ---- the confirm page ----

  test("the confirm page only aims at routes it knows are destructive", async () => {
    const ok = await fetch(
      `${base}/-/confirm?to=${encodeURIComponent("/mel/proj/settings/delete")}`,
      { headers: { cookie: owner } },
    );
    expect(ok.status).toBe(200);
    const html = await ok.text();
    expect(html).toContain('action="/mel/proj/settings/delete"');
    expect(html).toContain("Type mel/proj to continue");
    // The wording comes from the server, never from the link.
    expect(html).not.toContain("Totally safe");

    for (const to of [
      "https://evil.example/steal",
      "//evil.example/steal",
      "/mel/proj/issues/new",
      "/api/v1/repos/mel/proj",
    ]) {
      const res = await fetch(
        `${base}/-/confirm?to=${encodeURIComponent(to)}&title=Totally+safe`,
        { headers: { cookie: owner } },
      );
      expect(res.status).toBe(404);
    }
  });

  // ---- repo deletion ----

  test("deleting a repository needs admin and the name typed exactly", async () => {
    // The profile test above changed mel's email; the new one is taken as proven.
    proveAll(app);
    await fetch(`${base}/new`, {
      method: "POST",
      headers: { cookie: owner },
      body: form({ name: "doomed", visibility: "public" }),
      redirect: "manual",
    });
    const at = `${base}/mel/doomed/settings/delete`;

    // A stranger cannot even find the endpoint.
    expect(
      (
        await fetch(at, {
          method: "POST",
          headers: { cookie: stranger },
          body: form({ confirm: "mel/doomed" }),
          redirect: "manual",
        })
      ).status,
    ).toBe(404);
    expect(getRepo(app.db, "mel", "doomed")).toBeDefined();

    // The owner with the wrong phrase is bounced, and nothing is deleted.
    const wrong = await fetch(at, {
      method: "POST",
      headers: { cookie: owner },
      body: form({ confirm: "doomed" }),
      redirect: "manual",
    });
    expect(wrong.status).toBe(303);
    expect(getRepo(app.db, "mel", "doomed")).toBeDefined();

    const right = await fetch(at, {
      method: "POST",
      headers: { cookie: owner },
      body: form({ confirm: "mel/doomed" }),
      redirect: "manual",
    });
    expect(right.status).toBe(303);
    expect(getRepo(app.db, "mel", "doomed")).toBeUndefined();
  });

  // ---- label editing (the new core + action) ----

  test("a label can be renamed and recolored, but not onto another's name", async () => {
    const repo = getRepo(app.db, "mel", "proj")!;
    await fetch(`${base}/mel/proj/settings/labels`, {
      method: "POST",
      headers: { cookie: owner },
      body: form({ name: "chore", color: "0e8a16" }),
      redirect: "manual",
    });
    const chore = listLabels(app.db, repo.id).find((l) => l.name === "chore")!;

    await fetch(`${base}/mel/proj/settings/labels/${chore.id}`, {
      method: "POST",
      headers: { cookie: owner },
      body: form({ name: "housekeeping", color: "5319e7" }),
      redirect: "manual",
    });
    const renamed = listLabels(app.db, repo.id).find((l) => l.id === chore.id)!;
    expect(renamed.name).toBe("housekeeping");
    expect(renamed.color).toBe("5319e7");

    // Taking a name another label already holds is refused, not silently lost.
    await fetch(`${base}/mel/proj/settings/labels/${chore.id}`, {
      method: "POST",
      headers: { cookie: owner },
      body: form({ name: "bug", color: "5319e7" }),
      redirect: "manual",
    });
    expect(
      listLabels(app.db, repo.id).find((l) => l.id === chore.id)!.name,
    ).toBe("housekeeping");

    // A stranger cannot edit one at all.
    const refused = await fetch(
      `${base}/mel/proj/settings/labels/${chore.id}`,
      {
        method: "POST",
        headers: { cookie: stranger },
        body: form({ name: "theirs", color: "000000" }),
        redirect: "manual",
      },
    );
    expect(refused.status).toBe(404);
    expect(
      listLabels(app.db, repo.id).find((l) => l.id === chore.id)!.name,
    ).toBe("housekeeping");
  });

  // ---- search ----

  test("titles and repository names are searchable", async () => {
    const list = await (
      await fetch(`${base}/mel/proj/issues?q=needs&state=all`)
    ).text();
    expect(list).toContain("needs a label");
    const miss = await (
      await fetch(`${base}/mel/proj/issues?q=nothing-matches-this&state=all`)
    ).text();
    expect(miss).not.toContain("needs a label");
    expect(miss).toContain("Nothing open.");
    expect(miss).toContain("nothing-matches-this in the title ✕");

    // A LIKE wildcard typed into the box is a literal character, not a glob.
    const wildcard = await (
      await fetch(`${base}/mel/proj/issues?q=%25&state=all`)
    ).text();
    expect(wildcard).not.toContain("needs a label");

    // `mode=dev`: dev's face of the one `/search` (`searchPage`), the one
    // that names a repository as one.
    const whole = await (
      await fetch(`${base}/search?q=proj&mode=dev`, {
        headers: { cookie: owner },
      })
    ).text();
    // Just the results, not the shell: the palette index legitimately carries
    // every repo the viewer may see, and mel is the site admin here.
    const search = whole.slice(
      whole.indexOf("<main"),
      whole.indexOf("</main>"),
    );
    expect(search).toContain("mel/proj");
    expect(search).not.toContain("kim/secret");
  });

  test("the label colour input submits #rrggbb and is stored as six digits", async () => {
    const repo = getRepo(app.db, "mel", "proj")!;
    await fetch(`${base}/mel/proj/settings/labels`, {
      method: "POST",
      headers: { cookie: owner },
      body: form({ name: "tide", color: "#0E8A16" }),
      redirect: "manual",
    });
    const tide = listLabels(app.db, repo.id).find((l) => l.name === "tide");
    expect(tide?.color).toBe("0e8a16");

    // And the page offers a real colour control, so it works with no script.
    const page = await (
      await fetch(`${base}/mel/proj/settings/labels`, {
        headers: { cookie: owner },
      })
    ).text();
    expect(page).toContain('type="color"');
    expect(page).toContain('value="#0e8a16"');
  });

  // ---- markup that a browser will not silently rewrite ----

  /**
   * `<a>` inside `<a>` is not merely invalid: the HTML parser closes the
   * outer anchor and re-parents everything after it as a *sibling*, so a
   * list row visibly falls apart — the author's name and the trailing badge
   * escape the row's padding. This sweeps every list page for it.
   */
  test("no linked list row contains a nested link", async () => {
    const pages = [
      "/",
      "/mel/proj",
      "/mel/proj/issues",
      "/mel/proj/issues?state=all",
      "/mel/proj/pulls?state=all",
      "/mel/proj/commits",
      "/mel",
      "/search?q=a",
    ];
    for (const path of pages) {
      const html = await (
        await fetch(`${base}${path}`, { headers: { cookie: owner } })
      ).text();
      for (const match of html.matchAll(/<a\b[^>]*class="row"[^>]*>/g)) {
        const from = match.index + match[0].length;
        const body = html.slice(from, html.indexOf("</a", from));
        expect({ path, nested: /<a[\s>]/.test(body) }).toEqual({
          path,
          nested: false,
        });
      }
    }
  });

  test("an issue row leads with its word as a dot", async () => {
    const html = await (
      await fetch(`${base}/mel/proj/issues`, { headers: { cookie: owner } })
    ).text();
    const start = html.indexOf('<span class="row-lead"');
    expect(start).toBeGreaterThan(-1);
    // From the lead to the end of the row it belongs to.
    const row = html.slice(start, html.indexOf("</a", start));
    expect(row).toContain('class="dot"');
    expect(row).toContain('<span class="row-meta">');
    expect(row).toContain('data-word="told"');
    // The word is the row's state; no dev state badge repeats it.
    expect(html).not.toContain('class="badge" data-state="open"');
  });

  // ---- keyboard ----

  test("the tell composer is the thread's comment box, on the page and in place", async () => {
    const as = async (path: string) =>
      (await fetch(`${base}${path}`, { headers: { cookie: owner } })).text();
    const keys = /<form[^>]*class="(?:card )?comment-form"[^>]*data-box="[^"]+"[^>]*data-submit-key/;
    // Two kinds of page: the issue's comment box, and the tell composer.
    const issue = await as("/mel/proj/issues/1");
    const page = await as("/mel/proj/tell?from=/mel/proj/issues/1");
    for (const html of [issue, page]) {
      expect(html).toMatch(keys);
      expect(html).toContain('class="input"');
    }
    expect(issue).toContain('data-box="Write a comment"');
    expect(page).toContain('data-box="Tell the crew"');
    expect(page).toContain('action="/mel/proj/tell"');
    expect(page).toContain('name="text"');
    expect(page).toContain('<input type="hidden" name="from" value="/mel/proj/issues/1"');
    // In place it is the form alone, one line.
    const bit = await as("/mel/proj/tell?from=/mel/proj/issues/1&in=place");
    expect(bit.trim().startsWith("<form")).toBe(true);
    expect(bit).toContain('rows="1"');
    expect(bit).not.toContain("<html");
    // A `from` that is not a path on this forge is dropped, not echoed.
    const bad = await as("/mel/proj/tell?from=https://evil.example/");
    expect(bad).not.toContain('name="from"');
    expect(bad).not.toContain("evil.example");
    // Signed out it goes to sign in; a reader who may not direct finds nothing.
    const out = await fetch(`${base}/mel/proj/tell`, { redirect: "manual" });
    expect(out.status).toBe(303);
    // Signed in but not a writer, outsiders not let in: nothing there, in
    // place or not, and no palette row to it.
    for (const q of ["", "&in=place"]) {
      const res = await fetch(`${base}/mel/proj/tell?from=/mel/proj/issues/1${q}`, {
        headers: { cookie: stranger },
      });
      expect(res.status).toBe(404);
    }
    const rowsFor = async (cookie: string) => {
      const html = await (await fetch(`${base}/mel/proj`, { headers: { cookie } })).text();
      const block = html.match(
        /<script type="application\/json" id="palette-index">([\s\S]*?)<\/script>/,
      )?.[1];
      return (JSON.parse(block ?? '{"items":[]}') as { items: { t: string }[] }).items.map((i) => i.t);
    };
    expect((await rowsFor(stranger)).some((t) => t.endsWith("Tell the crew"))).toBe(false);
  });

  test("tellInPlace opens the server's box, Enter sends it with `from`, Escape closes it, a failure falls back to the link", async () => {
    const src = shellJs.match(/function tellInPlace[\s\S]*?\n  var closePalette/)?.[0] ?? "";
    expect(src).not.toBe("");
    // The click intercept matches the href the palette's row carries.
    const href = "/mel/proj/tell?from=" + encodeURIComponent("/mel/proj/files");
    const intercept = shellJs.match(/if \((\/\^[^\n]*?tell[^\n]*?\/)\.test\(h\)/)?.[1];
    expect(intercept).toBeDefined();
    expect(new RegExp((intercept as string).slice(1, -1)).test(href)).toBe(true);

    type Listener = (e: Record<string, unknown>) => void;
    const make = () => {
      const listeners: Record<string, Listener> = {};
      const ta = { value: "", focused: false, focus() { this.focused = true; } };
      const note = { textContent: "" };
      const form = { action: "/mel/proj/tell", addEventListener: (n: string, f: Listener) => (listeners["form" + n] = f) };
      const box: Record<string, unknown> = {
        id: "", className: "", innerHTML: "", removed: false,
        querySelector: (q: string) => (q === "form" ? form : q === "textarea" ? ta : note),
        addEventListener: (n: string, f: Listener) => (listeners[n] = f),
        remove() { this.removed = true; },
      };
      return { listeners, ta, note, box };
    };
    const run = async (answers: (url: string, init?: RequestInit) => Promise<unknown>) => {
      const m = make();
      const calls: { url: string; init: RequestInit | undefined }[] = [];
      const loc = { href: "" };
      const doc = {
        getElementById: () => null,
        createElement: () => m.box,
        body: { appendChild() {} },
      };
      const fetcher = async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return answers(url, init);
      };
      class FD { constructor(_f: unknown) {} *[Symbol.iterator]() { yield ["text", m.ta.value]; yield ["from", "/mel/proj/files"]; } }
      const fn = new Function("doc", "fetch", "window", "location", "FormData", `${src.replace(/\n  var closePalette$/, "")}; return tellInPlace;`)(
        doc, fetcher, { setTimeout: () => 0 }, loc, FD,
      ) as (h: string) => void;
      fn(href);
      await new Promise((r) => setTimeout(r, 5));
      return { m, calls, loc };
    };
    const reply = (body: unknown, ok = true) => ({ ok, text: async () => "<form></form>", json: async () => body });

    const good = await run(async (url) =>
      url.endsWith("&in=place") ? reply(null) : reply({ ok: true, flash: "kai is on it." }),
    );
    expect(good.calls[0]?.url).toBe(href + "&in=place");
    expect(good.m.ta.focused).toBe(true);
    // Enter on an empty box sends nothing; with text it POSTs the form.
    const enter = { key: "Enter", shiftKey: false, isComposing: false, target: good.m.ta, preventDefault() {} };
    good.m.listeners["keydown"]?.(enter);
    expect(good.calls).toHaveLength(1);
    good.m.ta.value = "fix the footer";
    good.m.listeners["keydown"]?.(enter);
    await new Promise((r) => setTimeout(r, 5));
    expect(good.calls).toHaveLength(2);
    expect(good.calls[1]?.url).toBe("/mel/proj/tell");
    expect(good.calls[1]?.init?.method).toBe("POST");
    expect(String(good.calls[1]?.init?.body)).toContain("from=%2Fmel%2Fproj%2Ffiles");
    expect(good.m.note.textContent).toBe("kai is on it.");
    // Shift+Enter is a new line, Escape closes.
    good.m.listeners["keydown"]?.({ ...enter, shiftKey: true });
    expect(good.calls).toHaveLength(2);
    good.m.listeners["keydown"]?.({ key: "Escape", stopPropagation() {} });
    expect(good.m.box.removed).toBe(true);

    // The box not coming (a 404, say) is the plain link.
    const bad = await run(async () => reply(null, false));
    expect(bad.loc.href).toBe(href);
  });

  test("every action bound to a key shows that key beside its label", async () => {
    const pull = `/mel/proj/pulls/${pullNumber}`;
    const paths = ["/", "/mel/proj", "/mel/proj/issues", "/mel/proj/issues/1", pull, `${pull}/files`, "/mel/proj/files", "/apps", "/asks", "/system"];
    let seen = 0;
    for (const path of paths) {
      const html = await (await fetch(`${base}${path}`, { headers: { cookie: owner } })).text();
      // The element a binding sits on, and for a radio the label around it.
      for (const m of html.matchAll(/<(a|button|span|input)\b[^>]*\bdata-shortcut="([^"]+)"[^>]*>/g)) {
        const chord = m[2]!;
        const from = m[1] === "input" ? html.lastIndexOf("<label", m.index) : m.index;
        const close = m[1] === "input" ? "</label>" : `</${m[1]}>`;
        const el = html.slice(from, html.indexOf(close, m.index));
        if (!new RegExp(`data-hint="(?:[^"]* · )?${chord}"`).test(el) && !el.includes(`<kbd class="keyhint">${chord}</kbd>`) && !chord.split(" ").every((k) => el.includes(`<kbd>${k}</kbd>`))) {
          throw new Error(`${path}: "${chord}" has no <kbd> beside its label`);
        }
        seen++;
      }
    }
    expect(seen).toBeGreaterThan(10);
    // The keys the page scripts bind without a data-shortcut are declared in
    // one list; each page that carries the action must show the key beside it.
    // A card is seeded so the feed always has its Dismiss to check.
    const mel = (getUserByName(app.db, "mel"))!;
    const proj = (await getRepo(app.db, "mel", "proj"))!;
    const seeded = openIssue(app, mel, proj, { title: "dismiss me" });
    if (!seeded.ok) throw new Error(seeded.error);
    expect(assignIssue(app, mel, proj, seeded.value, mel).ok).toBe(true);
    expect(shellJs).toContain(`['${NEW_ISSUE_KEY}'], openNewIssue]`);
    for (const k of SCRIPT_KEYS) {
      const page = await (await fetch(`${base}${k.page}`, { headers: { cookie: `${owner}; forge_mode=studio` } })).text();
      // A menu row draws the key in its column; anything else carries it as data-hint (#8930).
      const at = Math.max(page.indexOf(`<kbd class="keyhint">${k.key}</kbd>`), page.indexOf(`data-hint="${k.key}"`));
      const near = at < 0 ? "" : page.slice(Math.max(0, at - 400), at + 400);
      if (!near.includes(k.label)) throw new Error(`${k.page}: "${k.label}" shows no ${k.key} beside it`);
    }
  });

  test("the composer, the verdicts and the settings sections carry their keys", async () => {
    const as = async (path: string, cookie = "") =>
      (
        await fetch(`${base}${path}`, cookie ? { headers: { cookie } } : {})
      ).text();

    // An issue's comment box is the page's box: `c` lands in it, and
    // Cmd/Ctrl+Enter sends it. Signed out there is no box, so no key is promised.
    const issue = await as("/mel/proj/issues/1", owner);
    expect(issue).toMatch(
      /<form[^>]*class="comment-form"[^>]*data-box="Write a comment"[^>]*data-submit-key/,
    );
    expect(await as("/mel/proj/issues/1")).not.toContain("data-box=");
    // The close form is drawn from the design system's input, not page classes.
    expect(issue).toMatch(/<select[^>]*class="input"[^>]*name="reason"/);
    expect(issue).toMatch(/<input[^>]*class="input"[^>]*name="into"/);
    expect(issue).not.toContain("close-reason");
    expect(issue).not.toContain("close-into");

    // The verdicts are `v` chords on the radios, and only the verdicts this
    // person may pass: the author never sees `v a`, a reader only `v c`.
    const change = `/mel/proj/pulls/${pullNumber}`;
    const pull = `${change}/files`;
    const asAuthor = await as(pull, owner);
    expect(asAuthor).not.toContain('data-shortcut="v a"');
    expect(asAuthor).toMatch(
      /<input[^>]*value="changes_requested"[^>]*data-shortcut="v r"[^>]*title="Request changes"/,
    );
    expect(asAuthor).toMatch(
      /<input[^>]*value="commented"[^>]*data-shortcut="v c"[^>]*title="Comment"/,
    );
    const asReader = await as(pull, stranger);
    expect(asReader).not.toContain('data-shortcut="v a"');
    expect(asReader).not.toContain('data-shortcut="v r"');
    expect(asReader).toContain('data-shortcut="v c"');
    // Close, reopen and merge carry no key at all.
    for (const html of [await as(change, owner), issue]) {
      const state = html.slice(
        html.indexOf('id="thread-state"'),
        html.indexOf("</form>", html.indexOf('form="thread-state"')),
      );
      expect(state).not.toContain("data-shortcut");
    }
    const mergeAt = asAuthor.indexOf(`action="${change}/merge"`);
    expect(mergeAt).toBeGreaterThan(-1);
    expect(
      asAuthor.slice(mergeAt, asAuthor.indexOf("</form>", mergeAt)),
    ).not.toContain("data-shortcut");

    // A settings sidebar is rows: j/k walk the sections, and the main pane
    // is the page's box.
    for (const path of ["/settings", "/mel/proj/settings"]) {
      const html = await as(path, owner);
      const nav = html.slice(
        html.indexOf('<nav class="settings-nav"'),
        html.indexOf("</nav>", html.indexOf('<nav class="settings-nav"')),
      );
      const links = nav.match(/<a\b[^>]*>/g) ?? [];
      expect(links.length).toBeGreaterThan(1);
      for (const a of links) expect(a).toContain("data-nav");
      expect(nav).toContain('aria-current="page"');
      expect(html).toContain('class="settings-main" data-box="Edit the form"');
    }

    // The shell sends a form on Enter only with a modifier held, only for a
    // form that opted in, and nowhere else.
    expect(shellJs).toContain("['Mod+Enter'], function (e) {");
    expect(shellJs).toContain("if (f && f.hasAttribute('data-submit-key')) { e.preventDefault(); submitBox(f); }");
    const sends = shellJs
      .split("\n")
      .filter((l) => /requestSubmit|\.submit\(/.test(l));
    expect(sends).toHaveLength(1);
    // The one plain Enter is the palette's in-place tell: one line, in a box
    // the script itself laid over the page (`tellInPlace`, client.ts).
    const inPlace = shellJs.match(/function tellInPlace[\s\S]*?\n  var closePalette/)?.[0] ?? "";
    expect(inPlace).toContain("e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.target === ta");
    expect(shellJs.replace(inPlace, "")).not.toMatch(/'Enter' && !e\.(shift|meta|ctrl)Key/);
  });

  // ---- CSRF ----

  test("every destructive POST refuses a cross-origin submission", async () => {
    const targets = [
      "/mel/proj/issues/1/state",
      "/mel/proj/issues/1/labels",
      `/mel/proj/pulls/${pullNumber}/state`,
      `/mel/proj/pulls/${pullNumber}/merge`,
      "/mel/proj/settings",
      "/mel/proj/settings/labels",
      "/mel/proj/settings/delete",
      "/settings",
      "/settings/password",
      "/settings/tokens",
      "/settings/keys",
      "/logout",
    ];
    for (const path of targets) {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { cookie: owner, origin: "https://evil.example" },
        body: form({ state: "closed", confirm: "mel/proj" }),
        redirect: "manual",
      });
      expect([403, 404]).toContain(res.status);
    }
    // Nothing moved.
    expect(getRepo(app.db, "mel", "proj")).toBeDefined();
    const repo = getRepo(app.db, "mel", "proj")!;
    expect(getIssue(app.db, repo.id, 1)!.state).toBe("open");
  });
});

describe("the issue close form's styles", () => {
  const css = String(require("../src/web/style/content.ts").content);

  test("the 'close into' input is hidden until 'split into…' is chosen", () => {
    expect(css).toMatch(/\.form-actions input\[name="into"\]\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(
      /\.form-actions:has\(select\[name="reason"\] option\[value="split"\]:checked\)\s+input\[name="into"\]\s*\{[^}]*display:\s*inline-block/,
    );
    expect(css).not.toContain("close-reason");
    expect(css).not.toContain("close-into");
  });
});

describe("copyField", () => {
  test("a readonly input beside a copy button, with acronyms kept in the button's name", () => {
    const out = copyField("clone-ssh", 'ssh://git@h:22/a/b.git"><x', "SSH clone address", "Copy SSH clone URL").text;
    expect(out).toMatch(/<input[^>]*\bid="clone-ssh"/);
    expect(out).toMatch(/<input[^>]*\breadonly\b/);
    expect(out).toContain('aria-label="SSH clone address"');
    expect(out).toContain('value="ssh://git@h:22/a/b.git&quot;&gt;&lt;x"'); // escaped
    expect(out).toContain('data-copy="clone-ssh"');
    expect(out).toContain('aria-label="Copy SSH clone URL"');
  });

  test("the copy script reads an input's value and selects it in place", () => {
    expect(shellJs).toContain("src.value !== undefined ? src.value : src.textContent");
    expect(shellJs).toContain("if (el.select) { el.focus(); el.select(); return true; }");
  });
});
