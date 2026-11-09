/**
 * The studio: apps as the unit, three verbs, and a switch to dev. The same
 * URLs answer in both modes; the cookie decides which face they show.
 *
 * The suite is split by subject so no one file sets the gate's floor
 * (#2038): the rest of it is test/studio-*.test.ts.
 */

import { stylesheetAsset } from "../src/web/asset.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { enableApp } from "../src/actions/apps.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { linkIssue } from "../src/actions/dependencies.ts";
import {
  assignIssue,
  openIssue,
  setIssueState,
} from "../src/actions/issues.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import {
  commitToBranch,
  createRepo,
  updateRepoSettings,
} from "../src/actions/repos.ts";
import { getIssue, listIssues } from "../src/core/issues.ts";
import { getPull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import {
  claimRun,
  createRun,
  finishRun,
  noteRunProgress,
} from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { CHECK_FAILED_LIMIT } from "../src/crew/dispatch.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("the studio", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let repo: Repo;
  let cookie: string;

  const get = (path: string, extra: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      headers: { cookie: `${cookie}; forge_mode=studio`, ...extra },
      redirect: "manual",
    });
  const post = (path: string, body: Record<string, string>, extra = "") =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { cookie: `${cookie}${extra}`, origin: base },
      body: new URLSearchParams(body),
      redirect: "manual",
    });

  /** An app of alice's with scout on its crew. */
  const makeApp = async (name: string, description = ""): Promise<Repo> => {
    const made = await createRepo(app, alice, {
      name,
      visibility: "private",
      description,
    });
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
    expect(addToCrew(app, alice, made.value, "scout").ok).toBe(true);
    return made.value;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-studio-"));
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
    const scout = await createAgent(app, alice, { username: "scout" });
    if (!scout.ok) throw new Error(String(scout.error));
    repo = await makeApp("notes", "a place for notes");
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    // Git children may still be writing as the suite ends on a loaded machine.
    await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }, 60_000);

  test("there is one forge (#603): no mode toggle, no POST /mode, and a ?mode= address is the same page without it, the old cookie let go", async () => {
    const plainResponse = await fetch(`${base}/`, { headers: { cookie } });
    const plain = await plainResponse.text();
    expect(plain).toContain("Your apps");
    expect(plain).not.toContain("mode-toggle");
    expect(plain).not.toContain('action="/mode"');
    expect(plainResponse.headers.get("set-cookie")).toBeNull();
    // Your repositories are one step away, on your own page.
    expect(plain).toContain('href="/alice"');

    for (const path of ["/?mode=dev", "/alice/notes/issues?mode=studio&word=told"]) {
      const res = await fetch(`${base}${path}`, {
        headers: { cookie: `${cookie}; forge_mode=dev` },
        redirect: "manual",
      });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(
        path === "/?mode=dev" ? "/" : "/alice/notes/issues?word=told",
      );
      expect(res.headers.get("set-cookie")).toContain("forge_mode=; Max-Age=0");
    }
    // An old dev cookie changes nothing.
    const withDev = await (
      await fetch(`${base}/alice/notes`, {
        headers: { cookie: `${cookie}; forge_mode=dev` },
      })
    ).text();
    expect(withDev).toContain("Tell the crew");
    // The depth row on every repository's header: Files (or Code), Changes
    // (or Pulls) and Runs; Terminal only where SSH is on, which it is not here.
    expect(withDev).toContain('href="/alice/notes/files"');
    expect(withDev).toContain('href="/alice/notes/pulls"');
    expect(withDev).toContain('href="/alice/notes/runs"');
    expect(withDev).not.toContain('href="/settings/keys#terminal"');
    // The toggle's POST is gone with it.
    const flipped = await post("/mode", { mode: "dev", back: "/" });
    expect(flipped.status).toBe(404);
  });

  test("the palette lists apps first, then the other repositories (#906)", async () => {
    // Made after the app, so newest-first alone would list it ahead.
    const later = await createRepo(app, alice, {
      name: "palette-later",
      visibility: "public",
      description: "",
    });
    if (!later.ok) throw new Error(String(later.error));
    const html = await (await get("/feed")).text();
    const block = html.match(
      /<script type="application\/json" id="palette-index">([\s\S]*?)<\/script>/,
    )?.[1];
    if (block === undefined) throw new Error("no palette-index on the home");
    const rows = (JSON.parse(block) as { items: { t: string; c: string; x?: string; o?: string }[] }).items;
    const at = (t: string) => rows.findIndex((r) => r.t === t);
    // A repository and its app are one row; the app shows as its label and door.
    expect(rows[at("alice/notes")]?.c).toBe("Repositories");
    expect(rows[at("alice/notes")]?.x).toStartWith("App · ");
    expect(rows[at("alice/notes")]?.o).toBe("/alice/notes/app/production/open");
    expect(rows[at("alice/palette-later")]?.x).toBeUndefined();
    expect(at("alice/notes")).toBeLessThan(at("alice/palette-later"));
  });

  test("a repository with no app record keeps the studio's framing for every viewer: one card, one door to make it one; an app itself never shows the card", async () => {
    const plain = await createRepo(app, alice, {
      name: "plainhome",
      visibility: "public",
      description: "no app here",
    });
    if (!plain.ok) throw new Error(String(plain.error));
    const seeded = await commitToBranch(app, alice, plain.value, {
      message: "Start",
      files: [{ path: "README.md", content: "hi\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));

    const studio = await (await get("/alice/plainhome")).text();
    expect(studio).toContain("This repository has no app yet.");
    expect(studio).toContain(`href="/alice/plainhome/settings/app"`);
    expect(studio).toContain("Run as an app");

    // An old dev cookie changes nothing (#603): the same code page, the
    // same card, git's own tabs because it is not an app.
    const dev = await (
      await get("/alice/plainhome", { cookie: `${cookie}; forge_mode=dev` })
    ).text();
    expect(dev).toContain("README.md");
    expect(dev).toContain(">Commits<");
    expect(dev).toContain("This repository has no app yet.");

    // A signed-out reader of the same public repository sees the same
    // sentence but no door it could not walk through.
    const stranger = await (
      await fetch(`${base}/alice/plainhome`, {
        headers: { cookie: "forge_mode=studio" },
        redirect: "manual",
      })
    ).text();
    expect(stranger).toContain("This repository has no app yet.");
    expect(stranger).not.toContain("Run as an app");
    expect(stranger).not.toContain(`href="/alice/plainhome/settings/app"`);

    // An app itself never carries this card.
    const app_ = await (await get("/alice/notes")).text();
    expect(app_).not.toContain("This repository has no app yet.");
  });

  test("the studio's design is in the stylesheet, not in every page", async () => {
    // The rules are static, so they belong in the file the browser caches.
    // A studio page carries no <style> at all — only a page that computes CSS
    // for this request (label colors) is allowed one.
    for (const path of ["/", "/alice/notes", "/apps"]) {
      const html = await (await get(path)).text();
      expect(html).toContain(
        `<link rel="stylesheet" href="${stylesheetAsset().path}"`,
      );
      // The one style element every page carries is the boot style that paints
      // the canvas before the stylesheet arrives (layout.ts, `bootCss`); the
      // studio's own rules never ride inline.
      expect(html.match(/<style/g)).toHaveLength(1);
      expect(html).not.toMatch(/<style[^>]*>[^<]*\.(studio|dash|shelf)-/);
    }

    const sheet = await fetch(`${base}${stylesheetAsset().path}`);
    expect(sheet.headers.get("content-type")).toContain("text/css");
    const css = await sheet.text();
    expect(css).toContain("@keyframes studio-flash");
    expect(css).toContain('.board[data-focus="working"] #working');
    // In the `components` layer, last: an inline block used to win over every
    // layer, and last in `components` is the nearest place that still reads
    // the same — a `content` rule or a utility must keep out-specifying them.
    for (const rule of ["@keyframes studio-flash", ".board-region > h2"]) {
      expect(css.indexOf(rule)).toBeGreaterThan(
        css.indexOf("@layer components {"),
      );
      expect(css.indexOf(rule)).toBeLessThan(css.indexOf("@layer content {"));
    }
  });

  test("the head, tell box, word and shelf rows are §5's own parts: no studio-*, shelf-* or fcard-app class is left on a page (#3616)", async () => {
    const old = /class="[^"]*\b(?:fcard-app|shelf-desc|shelf-facts|shelf-meta|studio-ask-actions|studio-head|studio-tell|studio-word)\b/;
    for (const path of ["/", "/alice/notes", "/apps"]) {
      expect(await (await get(path)).text()).not.toMatch(old);
    }
    const studio = await (await get("/alice/notes")).text();
    expect(studio).toMatch(/<div class="page-head">\s*<div class="stack stack-tight">\s*<h1 class="bar">/);
    expect(studio).toContain('class="bar tell-box"');
  });

  test("the home and an app's page lay main and rail with .split's wide rail; no dash class is left (#4748)", async () => {
    for (const path of ["/feed", "/alice/notes"]) {
      const page = await (await get(path)).text();
      expect(page).not.toMatch(/class="[^"]*\bdash(?:-main|-rail)?\b/);
      expect(page).toContain('<div class="split" data-rail="wide">');
    }
    const css = await (await fetch(`${base}${stylesheetAsset().path}`)).text();
    expect(css).not.toMatch(/\.dash\b/);
  });

  test("telling the crew opens an issue and hands it to a builder", async () => {
    const told = await post("/alice/notes/tell", {
      text: "Make the notes page load in under a second on my phone.\n\nIt takes three seconds now.",
    });
    expect(told.status).toBe(303);
    const issue = listIssues(app.db, repo.id, { kind: "issue", limit: 5 })[0]!;
    expect(issue.title).toBe(
      "Make the notes page load in under a second on my phone.",
    );
    expect(issue.body).toContain("three seconds");
    expect(issue.assigneeName).toBe("scout");
    const again = await (await get("/alice/notes")).text();
    expect(again).toContain("waiting");
    expect(again).toContain(">scout<");
    const empty = await post("/alice/notes/tell", { text: "   " });
    expect(empty.status).toBe(303);
  });

  test("ship lands a change; say tells the crew", async () => {
    // Its own app, so the tell it ships is the only one waiting there.
    const repo = await makeApp("shipnotes");
    const told = await post("/alice/shipnotes/tell", {
      text: "Make the notes page faster.",
    });
    expect(told.status).toBe(303);
    const tell = listIssues(app.db, repo.id, { kind: "issue", limit: 5 })[0]!;
    expect(tell.assigneeName).toBe("scout");
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/fast",
      base: "main",
      message: "Faster",
      files: [{ path: "FAST.md", content: "fast\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "Faster",
      body: `Closes #${tell.number}`,
      baseBranch: "main",
      headBranch: "feature/fast",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    const said = await post(`/alice/shipnotes/pulls/${pull.number}/say`, {
      text: "Keep the images lazy too.",
    });
    expect(said.status).toBe(303);
    const check = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: pull.id,
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
      reason: "pull",
    });
    claimRun(app.db, check.id);
    finishRun(app.db, check.id, { state: "ok", summary: "check passed in 1s" });
    // A bare POST — a button with no fields, or a client that sent no body
    // at all — ships too: an empty form is not a bad request.
    const shipped = await fetch(
      `${base}/alice/shipnotes/pulls/${pull.number}/ship`,
      {
        method: "POST",
        headers: { cookie: `${cookie}; forge_mode=studio`, origin: base },
        redirect: "manual",
      },
    );
    expect(shipped.status).toBe(303);
    expect(getPull(app.db, repo.id, pull.number)?.mergedAt).not.toBeNull();
    expect(getIssue(app.db, repo.id, tell.number)?.state).toBe("closed");
    const page = await (await get("/alice/shipnotes")).text();
    expect(page).toContain("shipped");
    // What was told and then shipped is not still "waiting" in Now.
    expect(page).not.toContain(">waiting<");
    expect(getUserByName(app.db, "scout")).toBeDefined();
  });

  test("ship from the home returns to the home with a flash and one link; a foreign back lands on the pull page", async () => {
    const green = async (name: string) => {
      const branch = await commitToBranch(app, alice, repo, {
        branch: `feature/${name}`,
        base: "main",
        message: name,
        files: [{ path: `${name.toUpperCase()}.md`, content: `${name}\n` }],
      });
      if (!branch.ok) throw new Error(JSON.stringify(branch.error));
      const opened = await openPull(app, alice, repo, {
        title: name,
        body: "",
        baseBranch: "main",
        headBranch: `feature/${name}`,
      });
      if (!opened.ok) throw new Error(String(opened.error));
      const check = createRun(app.db, {
        repoId: repo.id,
        kind: "check",
        issueId: opened.value.id,
        env: `pull-${opened.value.number}`,
        commitOid: opened.value.headOid,
        reason: "pull",
      });
      claimRun(app.db, check.id);
      finishRun(app.db, check.id, { state: "ok", summary: "check passed in 1s" });
      return opened.value;
    };
    const home = await green("fromhome");
    const shipped = await post(
      `/alice/notes/pulls/${home.number}/ship`,
      { back: "/" },
      "; forge_mode=studio",
    );
    expect(shipped.status).toBe(303);
    expect(shipped.headers.get("location")).toBe("/");
    const flash = decodeURIComponent(
      (shipped.headers.get("set-cookie") ?? "").split("forge_flash=")[1] ?? "",
    );
    expect(flash).toContain(`Shipped #${home.number}`);
    expect(flash).toContain("see it live");
    expect(getPull(app.db, repo.id, home.number)?.mergedAt).not.toBeNull();

    const evil = await green("fromevil");
    const lost = await post(
      `/alice/notes/pulls/${evil.number}/ship`,
      { back: "https://evil.example/" },
      "; forge_mode=studio",
    );
    expect(lost.status).toBe(303);
    expect(lost.headers.get("location")).toBe(
      `/alice/notes/pulls/${evil.number}`,
    );
  });

  test("close from the home returns to the home", async () => {
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/closeme",
      base: "main",
      message: "Close me",
      files: [{ path: "CLOSEME.md", content: "x\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "Close me",
      body: "",
      baseBranch: "main",
      headBranch: "feature/closeme",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const n = opened.value.number;
    const closed = await post(
      `/alice/notes/pulls/${n}/state`,
      { state: "closed", back: "/" },
      "; forge_mode=studio",
    );
    expect(closed.status).toBe(303);
    expect(closed.headers.get("location")).toBe("/");
    expect(getPull(app.db, repo.id, n)?.state).toBe("closed");
  });

  test("a tell shipped long ago still reads shipped once it is buried under 250 later events", async () => {
    const told = openIssue(app, alice, repo, {
      title: "Buried tell",
      body: "",
    });
    if (!told.ok) throw new Error(String(told.error));
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/buried",
      base: "main",
      message: "Buried",
      files: [{ path: "BURIED.md", content: "buried\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "Buried",
      body: `Closes #${told.value.number}`,
      baseBranch: "main",
      headBranch: "feature/buried",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const merged = await mergePull(app, alice, repo, opened.value, "squash");
    if (!merged.ok) throw new Error(String(merged.error));
    expect(getIssue(app.db, repo.id, told.value.number)?.state).toBe("closed");

    // 250 events of other kinds, appended after the merge, so a scan of the
    // most recent 200 events of any kind would never reach the one that
    // actually closed this issue.
    for (let i = 0; i < 250; i++)
      app.bus.append({ kind: "push", repoId: repo.id, payload: { n: i } });

    const page = await (
      await get(`/alice/notes/issues/${told.value.number}`)
    ).text();
    expect(page).toContain('data-word="shipped"');
    expect(page).not.toContain('data-state="closed"');
    // The badge already says shipped; nobody was ever assigned, so the
    // assignee line has nothing true left to add and says nothing (#214).
    expect(page).not.toContain("nobody has it yet");
    expect(page).not.toContain("has it");
  });

  test("a pull on an app renders as one change page — the preview, the look and the decision, no diff; the diff is its Files step, and ?mode=dev changes nothing", async () => {
    const scout = getUserByName(app.db, "scout")!;
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/studio-pull",
      base: "main",
      message: "Studio pull",
      files: [{ path: "STUDIO_PULL.md", content: "a change\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    // Scout is an agent: this pull is the crew's, so a decision applies to
    // it once its check is green (`listOpenAgentPullsVisibleTo`).
    const opened = await openPull(app, scout, repo, {
      title: "Studio pull test",
      body: "Makes the thing faster.",
      baseBranch: "main",
      headBranch: "feature/studio-pull",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: pull.id,
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
      reason: "pull",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "ok", summary: "check passed in 1s" });

    const studio = await (
      await get(`/alice/notes/pulls/${pull.number}`)
    ).text();
    expect(studio).toContain("Studio pull test");
    expect(studio).toContain("Makes the thing faster.");
    expect(studio).toContain(
      `href="/alice/notes/app/pull-${pull.number}/open"`,
    );
    expect(studio).toContain('data-word="look"');
    expect(studio).toContain("Ship");
    expect(studio).toContain('id="comment-body"');
    expect(studio).toContain(`href="/alice/notes/pulls/${pull.number}/files"`);
    expect(studio).not.toContain("?mode=dev");
    expect(studio).not.toContain("diff-table");

    // The Files step carries the diff, under the same head.
    const files = await (
      await get(`/alice/notes/pulls/${pull.number}/files`)
    ).text();
    expect(files).toContain("Studio pull test");
    expect(files).toContain("diff-table");
    expect(files).toContain("STUDIO_PULL.md");
    expect(files).toContain(`action="/alice/notes/pulls/${pull.number}/merge"`);

    // There is no second page behind the mode: the cookie and the query
    // both answer the one change.
    for (const dev of [
      await get(`/alice/notes/pulls/${pull.number}`, {
        cookie: `${cookie}; forge_mode=dev`,
      }),
      await get(`/alice/notes/pulls/${pull.number}`),
    ]) {
      const text = await dev.text();
      expect(text).toContain('data-word="look"');
      expect(text).not.toContain("diff-table");
    }

    // Ship it, so it stops being an ask on the shared repo's home for the
    // tests that follow.
    const merged = await mergePull(app, alice, repo, pull, "squash");
    expect(merged.ok).toBe(true);
  });

  test("a failed check's own page says what failed — the counts and the first names, bounded, and escaped as text", async () => {
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/red-check",
      base: "main",
      message: "A change whose check goes red",
      files: [{ path: "RED.md", content: "red\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "A change whose check goes red",
      body: "",
      baseBranch: "main",
      headBranch: "feature/red-check",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: pull.id,
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
      reason: "pull",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, {
      state: "failed",
      summary: "check failed: check exited with code 1",
      checkDetail: {
        passed: 274,
        failed: 4,
        names: [
          "a pull closed under a running agent > the clone goes after it",
          "<script>alert(1)</script>",
          "a third one",
        ],
      },
    });

    const studio = await (
      await get(`/alice/notes/pulls/${pull.number}`)
    ).text();
    expect(studio).toContain('data-word="stopped"');
    expect(studio).toContain("274 passed, 4 failed");
    expect(studio).toContain(
      "a pull closed under a running agent &gt; the clone goes after it",
    );
    // A fourth failing test beyond the bound is only counted, not named.
    expect(studio).toContain("and 1 more");
    // A test name is arbitrary text from a subprocess: it reaches the page
    // escaped, never as markup a browser would run.
    expect(studio).not.toContain("<script>alert(1)</script>");
    expect(studio).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // The link to the run's full log is unchanged: a summary, not a
    // replacement for it.
    expect(studio).toContain(`href="/alice/notes/runs/${run.id}"`);
  });

  test("a change that no longer merges into its base says so, and offers no Ship — a mergeable green pull is unchanged", async () => {
    const scout = getUserByName(app.db, "scout")!;
    const base1 = await commitToBranch(app, alice, repo, {
      message: "Add a file two branches will fight over",
      files: [{ path: "CONFLICT.md", content: "base\n" }],
    });
    if (!base1.ok) throw new Error(JSON.stringify(base1.error));
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/conflicting",
      base: "main",
      message: "Scout's edit",
      files: [{ path: "CONFLICT.md", content: "base\nscout\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    // Main moves the same line the other way underneath the open branch.
    const onMain = await commitToBranch(app, alice, repo, {
      message: "Main's edit",
      files: [{ path: "CONFLICT.md", content: "base\nmain\n" }],
    });
    if (!onMain.ok) throw new Error(JSON.stringify(onMain.error));

    const opened = await openPull(app, scout, repo, {
      title: "Conflicting change",
      body: "This will not merge cleanly.",
      baseBranch: "main",
      headBranch: "feature/conflicting",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: pull.id,
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
      reason: "pull",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "ok", summary: "check passed in 1s" });

    const studio = await (
      await get(`/alice/notes/pulls/${pull.number}`)
    ).text();
    // Green check alone never reads as ready: the page says it conflicts,
    // names the file, and says what fixes it — and offers no Ship.
    expect(studio).toContain("conflicts with main");
    expect(studio).toContain("CONFLICT.md");
    expect(studio).toContain("bring the branch up to date");
    expect(studio).not.toContain("Ship");
    expect(studio).toContain("Bring up to date");
    // Still one of the five words — no sixth badge invented for this.
    expect(studio).toContain('data-word="look"');

    setIssueState(app, alice, repo, pull, "closed");

    // A mergeable green pull is unchanged by any of this.
    const clean = await commitToBranch(app, alice, repo, {
      branch: "feature/studio-clean",
      base: "main",
      message: "Clean change",
      files: [{ path: "CLEAN.md", content: "clean\n" }],
    });
    if (!clean.ok) throw new Error(JSON.stringify(clean.error));
    const openedClean = await openPull(app, scout, repo, {
      title: "Clean change",
      body: "Merges fine.",
      baseBranch: "main",
      headBranch: "feature/studio-clean",
    });
    if (!openedClean.ok) throw new Error(String(openedClean.error));
    const cleanPull = openedClean.value;
    const cleanRun = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: cleanPull.id,
      env: `pull-${cleanPull.number}`,
      commitOid: cleanPull.headOid,
      reason: "pull",
    });
    claimRun(app.db, cleanRun.id);
    finishRun(app.db, cleanRun.id, {
      state: "ok",
      summary: "check passed in 1s",
    });
    const cleanStudio = await (
      await get(`/alice/notes/pulls/${cleanPull.number}`)
    ).text();
    expect(cleanStudio).not.toContain("conflicts with main");
    expect(cleanStudio).toContain("Ship");
    expect(cleanStudio).toContain("green — ready for a look");

    const merged = await mergePull(app, alice, repo, cleanPull, "squash");
    expect(merged.ok).toBe(true);
  });

  test("a pull on a repository that is not an app is the same one change page, with the diff and the merge box on its Files step", async () => {
    const plain = await createRepo(app, alice, {
      name: "plainrepo",
      visibility: "private",
      description: "no app here",
    });
    if (!plain.ok) throw new Error(String(plain.error));
    const seeded = await commitToBranch(app, alice, plain.value, {
      message: "Start",
      files: [{ path: "README.md", content: "hi\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const branch = await commitToBranch(app, alice, plain.value, {
      branch: "feature/plain",
      base: "main",
      message: "Plain change",
      files: [{ path: "PLAIN.md", content: "plain\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, plain.value, {
      title: "Plain pull",
      body: "Nothing special.",
      baseBranch: "main",
      headBranch: "feature/plain",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;

    const change = await (
      await get(`/alice/plainrepo/pulls/${pull.number}`)
    ).text();
    expect(change).toContain("Plain pull");
    expect(change).toContain("data-word=");
    expect(change).not.toContain("diff-table");
    // No app: no preview and no look, and the decision does not say "app".
    expect(change).not.toContain("<h2>Preview</h2>");
    expect(change).toContain("Nothing here waits on a check to ship.");

    const files = await (
      await get(`/alice/plainrepo/pulls/${pull.number}/files`)
    ).text();
    expect(files).toContain("diff-table");
    expect(files).toContain("PLAIN.md");
    expect(files).toContain("Merge pull request");
    expect(files).toContain("feature/plain → main");
  });

  test("the Files step is refused to a reader who cannot see the change, exactly as the change is", async () => {
    const hidden = await createRepo(app, alice, {
      name: "hiddenfiles",
      visibility: "private",
      description: "",
    });
    if (!hidden.ok) throw new Error(String(hidden.error));
    const seeded = await commitToBranch(app, alice, hidden.value, {
      message: "Start",
      files: [{ path: "README.md", content: "hi\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const branch = await commitToBranch(app, alice, hidden.value, {
      branch: "secret",
      base: "main",
      message: "Secret",
      files: [{ path: "SECRET.md", content: "do not show\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, hidden.value, {
      title: "Hidden",
      body: "",
      baseBranch: "main",
      headBranch: "secret",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const n = opened.value.number;

    for (const path of [
      `/alice/hiddenfiles/pulls/${n}`,
      `/alice/hiddenfiles/pulls/${n}/files`,
      `/alice/hiddenfiles/pulls/${n + 1}/files`,
    ]) {
      const anon = await fetch(`${base}${path}`, { redirect: "manual" });
      expect(anon.status, path).toBe(404);
      expect(await anon.text()).not.toContain("SECRET.md");
    }
  });

  test("the crew's green change in a review-gated app offers no Ship until it is approved, and says why", async () => {
    const scout = getUserByName(app.db, "scout")!;
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/crew-gated",
      base: "main",
      message: "Crew gated",
      files: [{ path: "CREW_GATED.md", content: "a change\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, scout, repo, {
      title: "Crew gated change",
      body: "",
      baseBranch: "main",
      headBranch: "feature/crew-gated",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: pull.id,
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
      reason: "pull",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "ok", summary: "check passed" });
    const ship = `action="/alice/notes/pulls/${pull.number}/ship"`;
    const at = `/alice/notes/pulls/${pull.number}`;

    // Green and the crew's: Ship is offered while no review is required…
    expect(await (await get(at)).text()).toContain(ship);
    // …and not once this app requires an approving review it lacks.
    const gate = await updateRepoSettings(app, alice, repo, {
      requireReview: true,
    });
    if (!gate.ok) throw new Error(String(gate.error));
    try {
      const gated = await (await get(at)).text();
      expect(gated).not.toContain(ship);
      expect(gated).toContain("it waits on an approving review of what it is now");
    } finally {
      const off = await updateRepoSettings(app, alice, repo, {
        requireReview: false,
      });
      if (!off.ok) throw new Error(String(off.error));
    }
    expect(setIssueState(app, alice, repo, pull, "closed").ok).toBe(true);
  });

  test("in a review-gated app the crew's change whose check failed still offers its decision, and the reason it gives is the check, not the review", async () => {
    const scout = getUserByName(app.db, "scout")!;
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/crew-failed-gated",
      base: "main",
      message: "Crew failed",
      files: [{ path: "CREW_FAILED.md", content: "a change\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, scout, repo, {
      title: "Crew failed change",
      body: "",
      baseBranch: "main",
      headBranch: "feature/crew-failed-gated",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    const check = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: pull.id,
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
      reason: "pull",
    });
    claimRun(app.db, check.id);
    finishRun(app.db, check.id, { state: "failed", summary: "tests failed" });
    // The crew has tried as often as it may: a person decides now.
    for (let i = 0; i < CHECK_FAILED_LIMIT; i++) {
      const tryRun = createRun(app.db, {
        repoId: repo.id,
        kind: "agent",
        issueId: pull.id,
        actorId: scout.id,
        reason: "check_failed",
      });
      claimRun(app.db, tryRun.id);
      finishRun(app.db, tryRun.id, { state: "failed", summary: "still red" });
    }
    const gate = await updateRepoSettings(app, alice, repo, {
      requireReview: true,
    });
    if (!gate.ok) throw new Error(String(gate.error));
    try {
      const page = await (await get(`/alice/notes/pulls/${pull.number}`)).text();
      expect(page).toContain("Tell them");
      expect(page).not.toContain("it waits on an approving review");
      expect(page).not.toContain(`action="/alice/notes/pulls/${pull.number}/ship"`);
    } finally {
      const off = await updateRepoSettings(app, alice, repo, {
        requireReview: false,
      });
      if (!off.ok) throw new Error(String(off.error));
    }
    expect(setIssueState(app, alice, repo, pull, "closed").ok).toBe(true);
  });

  test("only a change's author or a writer is shown Close: a signed-in stranger on a public change may comment, never close", async () => {
    const open = await createRepo(app, alice, {
      name: "publicchange",
      visibility: "public",
      description: "",
    });
    if (!open.ok) throw new Error(String(open.error));
    const seeded = await commitToBranch(app, alice, open.value, {
      message: "Start",
      files: [{ path: "README.md", content: "hi\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const branch = await commitToBranch(app, alice, open.value, {
      branch: "a-change",
      base: "main",
      message: "A change",
      files: [{ path: "CHANGE.md", content: "x\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, open.value, {
      title: "A public change",
      body: "",
      baseBranch: "main",
      headBranch: "a-change",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const at = `/alice/publicchange/pulls/${opened.value.number}`;
    expect(await (await get(at)).text()).toContain(`action="${at}/state"`);

    const stranger = await createUser(app.db, { origin: "seed", trusted: true,
      username: "changestranger",
      email: "changestranger@forge.local",
      password: "a-good-passphrase",
    });
    if (!stranger.ok) throw new Error(stranger.error);
    const strangerCookie = (
      (
        await fetch(`${base}/signin`, {
          method: "POST",
          body: new URLSearchParams({
            username: "changestranger",
            password: "a-good-passphrase",
          }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
    const seen = await (
      await fetch(`${base}${at}`, { headers: { cookie: strangerCookie } })
    ).text();
    expect(seen).toContain('id="comment-body"');
    expect(seen).not.toContain(`action="${at}/state"`);
    expect(seen).not.toContain("Close change");
  });

  test("a mirrored change offers no Ship: it merges on the origin, from its Files step", async () => {
    const scout = getUserByName(app.db, "scout")!;
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/from-origin",
      base: "main",
      message: "From origin",
      files: [{ path: "FROM_ORIGIN.md", content: "a change\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, scout, repo, {
      title: "A change from an origin fork",
      body: "",
      baseBranch: "main",
      headBranch: "feature/from-origin",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: pull.id,
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
      reason: "pull",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "ok", summary: "check passed" });
    // A pull whose head lives at an origin, as a mirror's pulls do:
    // `mergePull` refuses it ("mirrored"), so the page must not offer it.
    app.db.run("UPDATE pull SET origin_head_repo = ?1 WHERE issue_id = ?2", [
      "octo/widgets",
      pull.id,
    ]);
    const page = await (await get(`/alice/notes/pulls/${pull.number}`)).text();
    expect(page).not.toContain(`action="/alice/notes/pulls/${pull.number}/ship"`);
    expect(page).toContain("it merges on the origin, from its Files step");
    expect(setIssueState(app, alice, repo, pull, "closed").ok).toBe(true);
  });

  test("a change that waits on a review never offers Ship, and the Files step's forms answer back on the Files step", async () => {
    const gated = await createRepo(app, alice, {
      name: "gatedchange",
      visibility: "private",
      description: "",
    });
    if (!gated.ok) throw new Error(String(gated.error));
    const seeded = await commitToBranch(app, alice, gated.value, {
      message: "Start",
      files: [{ path: "README.md", content: "hi\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const on = await updateRepoSettings(app, alice, gated.value, {
      requireReview: true,
    });
    if (!on.ok) throw new Error(String(on.error));
    const branch = await commitToBranch(app, alice, on.value, {
      branch: "wants-review",
      base: "main",
      message: "Wants review",
      files: [{ path: "REVIEW.md", content: "look\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, on.value, {
      title: "Wants a review",
      body: "",
      baseBranch: "main",
      headBranch: "wants-review",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const at = `/alice/gatedchange/pulls/${opened.value.number}`;

    const change = await (await get(at)).text();
    expect(change).not.toContain(`action="${at}/ship"`);
    expect(change).toContain("it waits on an approving review");

    // A merge the gate refuses lands back on the Files step, where the
    // merge box says why.
    const refused = await fetch(`${base}${at}/merge`, {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ strategy: "merge" }),
      redirect: "manual",
    });
    expect(refused.status).toBe(303);
    expect(refused.headers.get("location")).toBe(`${at}/files`);
    const files = await (await get(`${at}/files`)).text();
    expect(files).toContain("Waiting on review.");

    // A line comment lands on its own file, on the Files step.
    const commented = await fetch(`${base}${at}/review`, {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({
        path: "REVIEW.md",
        side: "new",
        line: "1",
        body: "why?",
      }),
      redirect: "manual",
    });
    expect(commented.status).toBe(303);
    expect(commented.headers.get("location")).toStartWith(`${at}/files#`);
  });

  test("a tell renders as one page — who has it, its runs, what blocks it with its form — and labels and the assignee in a closed Details; ?mode=dev changes nothing", async () => {
    const blocker = openIssue(app, alice, repo, {
      title: "Ground work",
      body: "Do this first.",
    });
    if (!blocker.ok) throw new Error(String(blocker.error));
    const told = openIssue(app, alice, repo, {
      title: "Make the export button work",
      body: "It does nothing right now.",
    });
    if (!told.ok) throw new Error(String(told.error));
    const linked = linkIssue(app, alice, repo, told.value, blocker.value);
    expect(linked.ok).toBe(true);
    const scout = getUserByName(app.db, "scout")!;
    const assigned = assignIssue(app, alice, repo, told.value, scout);
    expect(assigned.ok).toBe(true);
    const issue = getIssue(app.db, repo.id, told.value.number)!;
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: issue.id,
      actorId: scout.id,
      reason: "assigned",
    });
    claimRun(app.db, run.id);
    noteRunProgress(app.db, run.id, { costUsd: 0.12 });

    const studio = await (
      await get(`/alice/notes/issues/${issue.number}`)
    ).text();
    expect(studio).toContain("Make the export button work");
    expect(studio).toContain("scout");
    expect(studio).toContain("has it");
    expect(studio).toContain("Ground work");
    // What it waits on, in the studio's own noun (#158).
    expect(studio).toContain(
      `href="/alice/notes/issues/${blocker.value.number}"`,
    );
    expect(studio).toContain('data-word="working"');
    expect(studio).toContain("$0.12");
    expect(studio).toContain('id="comment-body"');
    expect(studio).not.toContain("?mode=dev");
    // Dev's controls, folded in: closed until asked for, never a mode.
    const details = studio.slice(
      studio.indexOf('<details class="disclosure'),
      studio.indexOf("</details>", studio.indexOf('<details class="disclosure')),
    );
    expect(details).toMatch(/^<details class="disclosure mt">/);
    expect(details).toContain("<h2>Labels</h2>");
    expect(details).toContain("<h2>Assignee</h2>");
    // What it waits for stays in view, with the form beside it.
    expect(details).not.toContain("/dependencies");
    expect(studio).toContain(`action="/alice/notes/issues/${issue.number}/dependencies"`);
    // The close keeps its reasons (done, dropped, split).
    expect(studio).toContain('name="reason"');

    for (const dev of [
      await get(`/alice/notes/issues/${issue.number}`, {
        cookie: `${cookie}; forge_mode=dev`,
      }),
      await get(`/alice/notes/issues/${issue.number}`),
    ]) {
      const text = await dev.text();
      expect(text).toContain('data-word="working"');
      expect(text).toContain('<details class="disclosure mt">');
    }
  });

});
