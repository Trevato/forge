/**
 * The toolbar's actions (#810): the page the bar opens on the forge, the
 * comment (a pull's comment on a preview, an issue on production) with a
 * preview first and a receipt after, the tell through the one tell door,
 * make it yours hidden from writers, signed-out showing nothing to do, a
 * cross-origin POST refused, and the working-now line only while a run is live.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { toolbarJs, toolbarTag } from "../src/apps/toolbar.ts";
import { createOrigin, linkRepoToOrigin } from "../src/core/origins.ts";
import { createIssue, getIssue, listComments, listIssues } from "../src/core/issues.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("toolbar actions", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let repoId: string;
  let pullId: string;
  let pullNumber: number;
  let aliceCookie: string;
  let bobCookie: string;
  const PAGE = "https://notes.example.test/a?b=1";

  const get = (path: string, cookie?: string) =>
    fetch(`${servers.url}${path}`, {
      headers: cookie ? { cookie } : {},
      redirect: "manual",
    });
  const post = (path: string, cookie: string, fields: Record<string, string>, origin = servers.url) =>
    fetch(`${servers.url}${path}`, {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
      redirect: "manual",
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-toolbar-actions-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string, first = false) => {
      const r = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!r.ok) throw new Error(r.error);
      return r.value;
    };
    alice = await mk("alice", true);
    bob = await mk("bob");
    const made = await newApp(app, alice, { name: "notes", description: "x", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repoId = made.value.repo.id;
    const pull = createIssue(app.db, { repoId, authorId: alice.id, title: "A change", kind: "pull" });
    if (!pull.ok) throw new Error(pull.error);
    pullId = pull.value.id;
    pullNumber = pull.value.number;
    aliceCookie = `forge_session=${createSession(app.db, alice.id).token}`;
    bobCookie = `forge_session=${createSession(app.db, bob.id).token}`;
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const url = (env: string) =>
    `/alice/notes/toolbar?env=${env}&page=${encodeURIComponent(PAGE)}`;

  test("the bar links to the forge page and never posts or reads the app", () => {
    expect(toolbarJs).toContain('"/toolbar"');
    // Its requests are all to the app's own origin: the crew line (#2233) and,
    // for the feedback door (#4758), the sender's notes and their status, and
    // the picture a sender ticked to send (#4820, sent through `call`).
    expect(toolbarJs.match(/fetch\(/g)?.length).toBe(2);
    expect(toolbarJs).toContain('call("/__forge/note/picture?note="');
    expect(toolbarJs).toContain('fetch("/__forge/crew"');
    expect(toolbarJs).toContain('call("/__forge/note"');
    expect(toolbarJs).not.toMatch(/FormData|\.send\(/);
    expect(toolbarJs).not.toContain("XMLHttpRequest");
    expect(toolbarJs).not.toContain("document.cookie");
    expect(toolbarTag("https://forge.test", { app: "notes", repo: "alice/notes", env: "production" })).toContain(
      'data-repo="alice/notes"',
    );
  });

  test("signed out: where you are and home only", async () => {
    const text = await (await get(url("production"))).text();
    expect(text).toContain("production");
    expect(text).toContain("Home");
    expect(text).not.toContain("Tell the crew");
    expect(text).not.toContain("Report this page");
    expect(text).not.toContain("Make it yours");
  });

  test("an issue number is not a pull: pull-N for a plain issue is not found, page and comment", async () => {
    const plain = createIssue(app.db, { repoId, authorId: alice.id, title: "Just an issue" });
    if (!plain.ok) throw new Error(plain.error);
    const env = `pull-${plain.value.number}`;
    expect((await get(url(env), aliceCookie)).status).toBe(404);
    const before = listComments(app.db, plain.value.id).length;
    const res = await post("/alice/notes/toolbar/comment", aliceCookie, { env, body: "hi", step: "post" });
    expect(res.status).toBe(404);
    expect(listComments(app.db, plain.value.id).length).toBe(before);
  });

  test("a bad env is not found", async () => {
    expect((await get(url("pull-abc"), aliceCookie)).status).toBe(404);
    expect((await get(url("pull-9999"), aliceCookie)).status).toBe(404);
  });

  test("writers do not see make it yours; others do; tell is offered to who may", async () => {
    const mine = await (await get(url("production"), aliceCookie)).text();
    expect(mine).not.toContain("make-it-yours");
    expect(mine).toContain("Tell the crew");
    const theirs = await (await get(url("production"), bobCookie)).text();
    expect(theirs).toContain("/alice/notes/make-it-yours");
  });

  test("working now appears only while a run is live, linked to its page", async () => {
    expect(await (await get(url("production"), bobCookie)).text()).not.toContain("data-working");
    const run = createRun(app.db, { repoId, kind: "agent", issueId: pullId, actorId: alice.id, summary: "wiring it" });
    claimRun(app.db, run.id);
    const live = await (await get(url("production"), bobCookie)).text();
    expect(live).toContain("data-working");
    expect(live).toContain(`/alice/notes/runs/${run.id}`);
    expect(await (await get(url(`pull-${pullNumber}`), bobCookie)).text()).toContain(`/runs/${run.id}`);
    finishRun(app.db, run.id, { state: "ok", summary: "done" });
    expect(await (await get(url("production"), bobCookie)).text()).not.toContain("data-working");
  });

  test("a preview comment: previewed first, then posted to the pull with a receipt", async () => {
    const fields = { env: `pull-${pullNumber}`, page: PAGE, body: "Looks <b>off</b>" };
    const preview = await post("/alice/notes/toolbar/comment", bobCookie, { ...fields, step: "preview" });
    expect(preview.status).toBe(200);
    const text = await preview.text();
    expect(text).toContain("Looks &lt;b&gt;off&lt;/b&gt;");
    expect(listComments(app.db, pullId).length).toBe(0);
    const sent = await post("/alice/notes/toolbar/comment", bobCookie, { ...fields, step: "post" });
    expect(sent.status).toBe(200);
    expect(await sent.text()).toContain(`/alice/notes/pulls/${pullNumber}#conversation`);
    const comments = listComments(app.db, pullId);
    expect(comments.length).toBe(1);
    expect(comments[0]!.body).toContain("<https://notes.example.test/a>");
  });

  test("a production comment opens an issue carrying the page address", async () => {
    const sent = await post("/alice/notes/toolbar/comment", bobCookie, {
      env: "production",
      page: PAGE,
      body: "The header overlaps",
      step: "post",
    });
    expect(sent.status).toBe(200);
    const link = /\/alice\/notes\/issues\/(\d+)/.exec(await sent.text());
    expect(link).not.toBeNull();
    const issue = getIssue(app.db, repoId, Number(link![1]));
    expect(issue?.title).toBe("The header overlaps");
    expect(issue?.body).toContain("<https://notes.example.test/a>");
  });

  test("a query or fragment on the page address never reaches the body", async () => {
    const sent = await post("/alice/notes/toolbar/comment", bobCookie, {
      env: "production",
      page: "https://notes.example.test/a?b=1#t=secret",
      body: "leaky?",
      step: "post",
    });
    const n = /issues\/(\d+)/.exec(await sent.text())![1]!;
    const body = getIssue(app.db, repoId, Number(n))!.body;
    expect(body).toContain("<https://notes.example.test/a>");
    expect(body).not.toContain("b=1");
    expect(body).not.toContain("secret");
    const pr = await post("/alice/notes/toolbar/comment", bobCookie, {
      env: `pull-${pullNumber}`,
      page: "https://notes.example.test/a?b=1#t=secret",
      body: "leaky?",
      step: "post",
    });
    expect(pr.status).toBe(200);
    for (const c of listComments(app.db, pullId)) {
      expect(c.body).not.toContain("b=1");
      expect(c.body).not.toContain("secret");
    }
  });

  test("a body that only overflows with the page line is refused as too long", async () => {
    const res = await post("/alice/notes/toolbar/comment", bobCookie, {
      env: "production",
      page: PAGE,
      body: "x".repeat(65_536),
      step: "post",
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("too long");
  });

  test("an address that is not http(s) is dropped, not carried", async () => {
    const sent = await post("/alice/notes/toolbar/comment", bobCookie, {
      env: "production",
      page: "javascript:alert(1)",
      body: "hello",
      step: "post",
    });
    const n = /issues\/(\d+)/.exec(await sent.text())![1]!;
    expect(getIssue(app.db, repoId, Number(n))?.body).not.toContain("javascript");
  });

  test("a cross-origin POST is refused and nothing is made", async () => {
    const before = listComments(app.db, pullId).length;
    const res = await post(
      "/alice/notes/toolbar/comment",
      bobCookie,
      { env: `pull-${pullNumber}`, body: "evil", step: "post" },
      "https://notes.example.test",
    );
    expect(res.status).toBe(403);
    expect(listComments(app.db, pullId).length).toBe(before);
  });

  test("signed-out comment is refused", async () => {
    const res = await post("/alice/notes/toolbar/comment", "", { env: "production", body: "hi", step: "post" });
    expect(res.status).toBe(403);
  });

  test("the page's tell form posts to the one tell door and the tell lands back on the page", async () => {
    const text = await (await get("/alice/notes/toolbar?env=production", aliceCookie)).text();
    const form = /<form method="post" action="([^"]+\/tell)"[^>]*>([\s\S]*?)<\/form>/.exec(text);
    expect(form).not.toBeNull();
    const from = /name="from" value="([^"]+)"/.exec(form![2]!)![1]!.replaceAll("&amp;", "&");
    expect(form![1]).toBe("/alice/notes/tell");
    const before = listIssues(app.db, repoId, {}).length;
    const res = await post(form![1]!, aliceCookie, { text: "Make the header smaller", from });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(from);
    expect(from.startsWith("/alice/notes/toolbar?env=production")).toBe(true);
    const made = listIssues(app.db, repoId, {}).filter((i) => i.title === "Make the header smaller");
    expect(made.length).toBe(1);
    expect(listIssues(app.db, repoId, {}).length).toBe(before + 1);
    expect(made[0]!.body).toContain("Told from");
  });

  test("the tell form carries the page, and the pull on a preview, into the tell", async () => {
    const tellForm = async (env: string) => {
      const text = await (await get(url(env), aliceCookie)).text();
      return /<form method="post" action="[^"]+\/tell"[^>]*>([\s\S]*?)<\/form>/.exec(text)![1]!;
    };
    const prod = await tellForm("production");
    expect(prod).toContain(`name="page" value="https://notes.example.test/a"`);
    expect(prod).not.toContain('name="pull"');
    expect(prod).not.toContain('name="from"');
    const res = await post("/alice/notes/tell", aliceCookie, { text: "Page tell prod", page: "https://notes.example.test/a" });
    expect(res.status).toBe(200);
    const one = listIssues(app.db, repoId, {}).find((i) => i.title === "Page tell prod")!;
    expect(one.body).toContain("- page: https://notes.example.test/a");
    expect(one.body).not.toContain("- pull:");

    const prev = await tellForm(`pull-${pullNumber}`);
    expect(prev).toContain(`name="pull" value="${pullNumber}"`);
    await post("/alice/notes/tell", aliceCookie, {
      text: "Page tell preview",
      page: "https://notes.example.test/b",
      pull: String(pullNumber),
    });
    const two = listIssues(app.db, repoId, {}).find((i) => i.title === "Page tell preview")!;
    expect(two.body).toContain("- page: https://notes.example.test/b");
    expect(two.body).toContain(`- pull: #${pullNumber}`);
  });

  test("an off-origin or over-long page is dropped from the form, and escaped", async () => {
    const bad = await (await get("/alice/notes/toolbar?env=production&page=javascript:alert(1)", aliceCookie)).text();
    expect(bad).toContain('name="from"');
    expect(bad).not.toContain("javascript:");
    const long = await (await get(`/alice/notes/toolbar?env=production&page=${encodeURIComponent("https://a.test/" + "x".repeat(600))}`, aliceCookie)).text();
    expect(long).toContain('name="from"');
    const quote = await (await get(`/alice/notes/toolbar?env=production&page=${encodeURIComponent('https://a.test/"><script>')}`, aliceCookie)).text();
    expect(quote).not.toContain("<script>");
  });

  test("a live run on a sealed issue is not shown to a reader who did not file it", async () => {
    const sealed = createIssue(app.db, {
      repoId,
      authorId: alice.id,
      title: "SEALEDTITLE hole",
      sealed: true,
    });
    if (!sealed.ok) throw new Error(sealed.error);
    const run = createRun(app.db, {
      repoId,
      kind: "agent",
      issueId: sealed.value.id,
      actorId: alice.id,
      summary: "SEALEDSUMMARY fixing the hole",
    });
    claimRun(app.db, run.id);
    const theirs = await (await get(url("production"), bobCookie)).text();
    expect(theirs).not.toContain("data-working");
    expect(theirs).not.toContain("SEALEDSUMMARY");
    expect(theirs).not.toContain(run.id);
    const mine = await (await get(url("production"), aliceCookie)).text();
    expect(mine).toContain("SEALEDSUMMARY");
    finishRun(app.db, run.id, { state: "ok", summary: "done" });
  });

  test("reporting on a mirrored repository goes through the origin's rules, not around them", async () => {
    const made = await newApp(app, alice, { name: "mirrored", description: "x", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const origin = createOrigin(app.db, dataDir, {
      userId: alice.id,
      kind: "forgejo",
      apiUrl: "https://origin.example.test/api/v1",
      webUrl: "https://origin.example.test",
      login: "alice",
      token: "t",
    });
    if (!origin.ok) throw new Error(origin.error);
    linkRepoToOrigin(app.db, made.value.repo.id, {
      originId: origin.value.id,
      fullName: "alice/mirrored",
      remoteId: "1",
      htmlUrl: "https://origin.example.test/alice/mirrored",
    });
    // Bob did not connect the origin: write-through refuses him, so no issue
    // is invented locally.
    const res = await post("/alice/mirrored/toolbar/comment", bobCookie, {
      env: "production",
      body: "hello",
      step: "post",
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("Only the person who connected this origin");
    expect(listIssues(app.db, made.value.repo.id, {}).filter((i) => i.title === "hello")).toEqual([]);
  });

  test("a running run older than the twenty newest is still found", async () => {
    const old = createRun(app.db, { repoId, kind: "agent", issueId: pullId, actorId: alice.id, summary: "OLDRUNNING" });
    claimRun(app.db, old.id);
    for (let i = 0; i < 25; i++) {
      const r = createRun(app.db, { repoId, kind: "agent", issueId: pullId, actorId: alice.id, summary: `n${i}` });
      claimRun(app.db, r.id);
      finishRun(app.db, r.id, { state: "ok", summary: "done" });
    }
    const text = await (await get(url("production"), aliceCookie)).text();
    expect(text).toContain("OLDRUNNING");
    finishRun(app.db, old.id, { state: "ok", summary: "done" });
  });
});
