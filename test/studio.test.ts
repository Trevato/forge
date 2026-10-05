import { stylesheetAsset } from "../src/web/asset.ts";
/**
 * The studio: apps as the unit, three verbs, and a switch to dev. The same
 * URLs answer in both modes; the cookie decides which face they show.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { enableApp } from "../src/actions/apps.ts";
import { previewEnv, type EnvName } from "../src/apps/data.ts";
import {
  AppsRuntime,
  type EnvState,
  type EnvStatus,
} from "../src/apps/runtime.ts";
import { getAppByRepo, type AppRecord } from "../src/core/apps.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { addTeamMember, createOrg, createTeam } from "../src/actions/orgs.ts";
import { linkIssue } from "../src/actions/dependencies.ts";
import {
  assignIssue,
  openIssue,
  setIssueLabels,
  setIssueState,
} from "../src/actions/issues.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import {
  commitToBranch,
  createLabel,
  createRepo,
  updateRepoSettings,
} from "../src/actions/repos.ts";
import { setCrewRole } from "../src/core/agents.ts";
import { recordDecision } from "../src/core/decisions.ts";
import { getIssue, listIssues, type Issue } from "../src/core/issues.ts";
import { looksForEnv, recordLook } from "../src/core/looks.ts";
import { getPull, mergedPullCount, type Pull } from "../src/core/pulls.ts";
import {
  getRepoById,
  setDirectionIssue,
  type Repo,
} from "../src/core/repos.ts";
import {
  agentRunTotals,
  claimRun,
  createRun,
  finishRun,
  getRun,
  listRuns,
  markServing,
  noteRunProgress,
  previewLatency,
  STOPPED_SUMMARY,
  type Run,
} from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import type { Decider } from "../src/crew/decide.ts";
import { CHECK_FAILED_LIMIT } from "../src/crew/dispatch.ts";
import { serve, type Servers } from "../src/http/server.ts";
import {
  NOBODY_ON_CREW,
  pullWord,
  runWord,
  servingHistory,
  type WordCtx,
} from "../src/web/studio/words.ts";
import { servedPhrase } from "../src/web/ui.ts";
import { repoDir } from "../src/git/repos.ts";
import { appendRunLog } from "../src/runs/log.ts";

/** One transparent pixel, dropped where a look would sit. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * A runtime registered for `app`, never started, answering every app's
 * production with `stateOf` (running unless told) — the door shows only
 * what is up or wakes. The returned function takes it away again.
 */
async function serving(
  app: App,
  servers: Servers,
  stateOf: (record: AppRecord) => EnvState = () => "running",
): Promise<() => Promise<void>> {
  const runtime = new AppsRuntime(app, {
    domain: "studio-door.test",
    scheme: "http",
    publicPort: servers.port,
    forgeUrl: servers.url,
  });
  const status = spyOn(AppsRuntime.prototype, "status").mockImplementation(
    (record: AppRecord): EnvStatus[] => [
      {
        env: "production",
        state: stateOf(record),
        // Serving the commit its newest picture is of.
        commitOid: looksForEnv(app.db, record.id, "production")[0]?.commitOid ?? "",
      } as EnvStatus,
    ],
  );
  return async () => {
    status.mockRestore();
    await runtime.stop();
  };
}

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

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-studio-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, { trusted: true,
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
    const made = await createRepo(app, alice, {
      name: "notes",
      visibility: "private",
      description: "a place for notes",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [
        {
          path: "package.json",
          content: '{"name":"notes","scripts":{"start":"bun run server.ts"}}\n',
        },
        {
          path: "server.ts",
          content:
            "Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('ok') });\n",
        },
      ],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, alice, repo, { slug: "notes" });
    if (!enabled.ok) throw new Error(String(enabled.error));
    const scout = await createAgent(app, alice, { username: "scout" });
    if (!scout.ok) throw new Error(String(scout.error));
    expect(addToCrew(app, alice, repo, "scout").ok).toBe(true);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("home is the studio by default with no cookie at all; ?mode= is a link that switches this browser, both ways", async () => {
    const plainResponse = await fetch(`${base}/`, { headers: { cookie } });
    const plain = await plainResponse.text();
    expect(plain).toContain("Your apps");
    expect(plain).toContain("notes");
    expect(plain).not.toContain("<h1>Your repositories</h1>");
    expect(plainResponse.headers.get("set-cookie")).toBeNull();

    // `?mode=studio` is a no-op switch here, but it still sets the cookie —
    // the same link works from a dev-cookied browser too.
    const toStudio = await fetch(`${base}/?mode=studio`, {
      headers: { cookie },
    });
    expect(toStudio.headers.get("set-cookie")).toContain("forge_mode=studio");

    const devResponse = await fetch(`${base}/?mode=dev`, {
      headers: { cookie },
    });
    const dev = await devResponse.text();
    expect(dev).toContain("<h1>Your repositories</h1>");
    expect(dev).not.toContain("Your apps");
    expect(devResponse.headers.get("set-cookie")).toContain("forge_mode=dev");

    // `?mode=dev` still wins for this browser even once studio's cookie is set.
    const stillDev = await (
      await fetch(`${base}/?mode=dev`, {
        headers: { cookie: `${cookie}; forge_mode=studio` },
      })
    ).text();
    expect(stillDev).toContain("<h1>Your repositories</h1>");

    // And the link's switch stuck: this browser stays in dev with no query.
    const devCookie = (devResponse.headers.get("set-cookie") ?? "").split(
      ";",
    )[0]!;
    const asDev = await (
      await fetch(`${base}/`, {
        headers: { cookie: `${cookie}; ${devCookie}` },
      })
    ).text();
    expect(asDev).toContain("<h1>Your repositories</h1>");

    // The toggle's own POST still flips it back, cookie and all.
    const flipped = await post("/mode", { mode: "studio", back: "/" });
    expect(flipped.status).toBe(303);
    expect(flipped.headers.get("set-cookie")).toContain("forge_mode=studio");
    const bad = await post("/mode", { mode: "neither", back: "/" });
    expect(bad.headers.get("set-cookie")).toContain("forge_mode=;");
  });

  /**
   * The shelf row, byte for byte: whoever draws it (`studio/shelf.ts`) and
   * from wherever, an app on a shelf is a dot, its name, its one line, what
   * the crew last did there, the badge for whether it is live, and a link
   * into it. This pins the rendering so a move of the code cannot quietly
   * move the page.
   */
  test("an app is one row on the shelf: a dot, its name and line, what the crew last did, the way in", async () => {
    const home = await (await get("/")).text();
    const at = home.indexOf('href="/alice/notes"');
    expect(at).toBeGreaterThan(-1);
    const start = home.lastIndexOf("<li>", at);
    const shelfRow = home.slice(start, home.indexOf("</li>", at) + 5);
    // The bytes the home rendered before the row moved into its own
    // module, escaped so no formatter can reflow them.
    expect(shelfRow).toBe(
      '<li>\n    <a href="/alice/notes" class="row"\n  \n  data-nav tabindex="-1"><span class="row-lead"><span\n    class="dot"\n    \n  ></span></span>\n    <span class="row-main">\n      <span\n        class="row-title"\n        title="a place for notes"\n        >notes</span\n      >\n      <span class="row-meta"><span class="shelf-meta"\n          ><span class="shelf-desc">a place for notes</span><span class="shelf-facts"\n            >· <span class="muted">quiet — tell the crew something</span></span\n          ></span\n        ></span>\n    </span>\n    <span class="row-trail">\n        <span class="badge" data-tone="default">not running</span></span></a>\n  </li>',
    );
  });

  test("a 400-character description is one clamped line on the row, whole in its title, and the facts keep their own span (#69)", async () => {
    const long = "paragraph ".repeat(40).trim();
    expect(long.length).toBeGreaterThanOrEqual(399);
    app.db.run("UPDATE repo SET description = ?1 WHERE id = ?2", [long, repo.id]);
    try {
      const home = await (await get("/")).text();
      const at = home.indexOf('href="/alice/notes"');
      const shelfRow = home.slice(home.lastIndexOf("<li>", at), home.indexOf("</li>", at));
      expect(shelfRow).toContain(`title="${long}"`);
      expect(shelfRow).toContain(`<span class="shelf-desc">${long}</span>`);
      expect(shelfRow).toContain('class="shelf-facts"');
      // The facts sit outside the description, so it cannot push them out.
      expect(shelfRow.indexOf('class="shelf-facts"')).toBeGreaterThan(
        shelfRow.indexOf("</span>", shelfRow.indexOf('class="shelf-desc"')),
      );
    } finally {
      app.db.run("UPDATE repo SET description = ?1 WHERE id = ?2", ["a place for notes", repo.id]);
    }
  });

  test("an app's home is the app for every viewer, and its code is the Files step one tab over", async () => {
    const studio = await (await get("/alice/notes")).text();
    expect(studio).toContain("Tell the crew");
    expect(studio).toContain("<h2>Crew</h2>");
    expect(studio).toContain(">Studio<");
    expect(studio).toContain('href="/alice/notes/files"');
    expect(studio).not.toContain(">Commits<");
    // No second home behind the mode: the cookie and the query both get
    // the app.
    for (const dev of [
      await get("/alice/notes", { cookie: `${cookie}; forge_mode=dev` }),
      await get("/alice/notes?mode=dev"),
    ]) {
      const text = await dev.text();
      expect(text).toContain("Tell the crew");
      expect(text).toContain('href="/alice/notes/files"');
      expect(text).not.toContain("?mode=studio");
    }

    // The Files step is the code page: the tree, the README, the rail.
    const files = await (await get("/alice/notes/files")).text();
    expect(files).toContain("package.json");
    expect(files).toContain("server.ts");
    expect(files).not.toContain("Tell the crew");
    // An older `?ref=` link to the app's code is handed on to it.
    const old = await get("/alice/notes?ref=main");
    expect(old.status).toBe(303);
    expect(old.headers.get("location")).toBe("/alice/notes/files?ref=main");
  });

  test("/files on a repository that is not an app is its home, which already is its code", async () => {
    const plain = await createRepo(app, alice, {
      name: "plainfiles",
      visibility: "private",
      description: "",
    });
    if (!plain.ok) throw new Error(String(plain.error));
    const res = await get("/alice/plainfiles/files?ref=main");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/plainfiles?ref=main");
    // And a reader who cannot see it gets the forge's not-found, never a
    // redirect that says it exists.
    const anon = await fetch(`${base}/alice/plainfiles/files`, {
      redirect: "manual",
    });
    expect(anon.status).toBe(404);
    const anonApp = await fetch(`${base}/alice/notes/files`, {
      redirect: "manual",
    });
    expect(anonApp.status).toBe(404);
  });

  test("a repository with no app record keeps the studio's framing: one card, one door to make it one; ?mode=dev is unchanged, and an app itself never shows the card", async () => {
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

    // `?mode=dev` on the very same URL renders exactly what it always has:
    // the code, no card above it at all.
    const dev = await (
      await get("/alice/plainhome", { cookie: `${cookie}; forge_mode=dev` })
    ).text();
    expect(dev).toContain("README.md");
    expect(dev).toContain(">Commits<");
    expect(dev).not.toContain("This repository has no app yet.");
    expect(dev).not.toContain("Run as an app");

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
      expect(html).not.toContain("<style");
    }

    const sheet = await fetch(`${base}${stylesheetAsset().path}`);
    expect(sheet.headers.get("content-type")).toContain("text/css");
    const css = await sheet.text();
    expect(css).toContain(".studio-tell textarea");
    expect(css).toContain(".studio-ask-actions");
    expect(css).toContain("@keyframes studio-flash");
    expect(css).toContain('.board-fill[data-w="100"]');
    // In the `components` layer, last: an inline block used to win over every
    // layer, and last in `components` is the nearest place that still reads
    // the same — a `content` rule or a utility must keep out-specifying them.
    for (const rule of [".studio-tell textarea", ".board-h"]) {
      expect(css.indexOf(rule)).toBeGreaterThan(
        css.indexOf("@layer components {"),
      );
      expect(css.indexOf(rule)).toBeLessThan(css.indexOf("@layer content {"));
    }
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
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/fast",
      base: "main",
      message: "Faster",
      files: [{ path: "FAST.md", content: "fast\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "Faster",
      body: "Closes #1",
      baseBranch: "main",
      headBranch: "feature/fast",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    const said = await post(`/alice/notes/pulls/${pull.number}/say`, {
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
      `${base}/alice/notes/pulls/${pull.number}/ship`,
      {
        method: "POST",
        headers: { cookie: `${cookie}; forge_mode=studio`, origin: base },
        redirect: "manual",
      },
    );
    expect(shipped.status).toBe(303);
    expect(getPull(app.db, repo.id, pull.number)?.mergedAt).not.toBeNull();
    expect(getIssue(app.db, repo.id, 1)?.state).toBe("closed");
    const page = await (await get("/alice/notes")).text();
    expect(page).toContain("shipped");
    // What was told and then shipped is not still "waiting" in Now.
    expect(page).not.toContain(">waiting<");
    expect(getUserByName(app.db, "scout")).toBeDefined();
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

  test("a pull on an app renders as a studio page — the preview, the look and the decision, no diff; ?mode=dev still renders the diff", async () => {
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
    expect(studio).toContain(
      `href="/alice/notes/pulls/${pull.number}?mode=dev"`,
    );
    expect(studio).not.toContain("diff-table");

    // The dev page, either by cookie or by the one-off query, is untouched
    // and still carries the diff.
    const devCookie = await (
      await get(`/alice/notes/pulls/${pull.number}`, {
        cookie: `${cookie}; forge_mode=dev`,
      })
    ).text();
    expect(devCookie).toContain("diff-table");
    expect(devCookie).toContain("STUDIO_PULL.md");

    const devQuery = await (
      await get(`/alice/notes/pulls/${pull.number}?mode=dev`)
    ).text();
    expect(devQuery).toContain("diff-table");

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

  test("a pull on a repository that is not an app renders exactly what it renders today, even in studio mode", async () => {
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

    const studioCookie = await (
      await get(`/alice/plainrepo/pulls/${pull.number}`)
    ).text();
    expect(studioCookie).toContain("diff-table");
    expect(studioCookie).toContain("PLAIN.md");
    expect(studioCookie).toContain("Merge pull request");
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
      `href="/alice/notes/tells/${blocker.value.number}"`,
    );
    expect(studio).toContain('data-word="working"');
    expect(studio).toContain("$0.12");
    expect(studio).toContain('id="comment-body"');
    expect(studio).not.toContain("?mode=dev");
    // Dev's controls, folded in: closed until asked for, never a mode.
    const details = studio.slice(
      studio.indexOf('<details class="quiet-details'),
      studio.indexOf("</details>", studio.indexOf('<details class="quiet-details')),
    );
    expect(details).toMatch(/^<details class="quiet-details mt">/);
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
      await get(`/alice/notes/issues/${issue.number}?mode=dev`),
    ]) {
      const text = await dev.text();
      expect(text).toContain('data-word="working"');
      expect(text).toContain('<details class="quiet-details mt">');
    }
  });

  test("a reader of a public tell sees its Details but none of the forms that change it", async () => {
    const open = await createRepo(app, alice, {
      name: "publictell",
      visibility: "public",
      description: "",
    });
    if (!open.ok) throw new Error(String(open.error));
    const told = openIssue(app, alice, open.value, { title: "Anyone may read" });
    if (!told.ok) throw new Error(String(told.error));
    const at = `/alice/publictell/issues/${told.value.number}`;
    const anon = await (await fetch(`${base}${at}`)).text();
    expect(anon).toContain("Anyone may read");
    expect(anon).toContain('<details class="quiet-details mt">');
    for (const verb of ["assignee", "labels", "dependencies", "state", "comments"])
      expect(anon, verb).not.toContain(`action="${at}/${verb}"`);
  });

  test("the repository's direction never reads as waiting forever", async () => {
    const direction = openIssue(app, alice, repo, {
      title: "Direction",
      body: "Ship faster.",
    });
    if (!direction.ok) throw new Error(String(direction.error));
    setDirectionIssue(app.db, repo.id, direction.value.id);

    const studio = await (
      await get(`/alice/notes/issues/${direction.value.number}`)
    ).text();
    expect(studio).toContain("standing direction");
    expect(studio).not.toContain('data-word="told"');
    // The direction keeps its own sentence; nobody was assigned, so the
    // assignee line does not add a second, contradicting one (#214).
    expect(studio).not.toContain("nobody has it yet");

    // Leave the repository as the other tests in this suite found it.
    setDirectionIssue(app.db, repo.id, null);
  });

  test("a tell on a repository that is not an app renders exactly what it renders today, even in studio mode", async () => {
    const plain = await createRepo(app, alice, {
      name: "plaintell",
      visibility: "private",
      description: "no app here",
    });
    if (!plain.ok) throw new Error(String(plain.error));
    const told = openIssue(app, alice, plain.value, {
      title: "Plain issue",
      body: "Nothing special.",
    });
    if (!told.ok) throw new Error(String(told.error));

    const studioCookie = await (
      await get(`/alice/plaintell/issues/${told.value.number}`)
    ).text();
    expect(studioCookie).toContain("<h2>Labels</h2>");
    expect(studioCookie).toContain("<h2>Assignee</h2>");
    expect(studioCookie).toContain("<h2>Depends on</h2>");
  });

  test("everything told is the one issue list, in the studio's own words; the word filter narrows it, and ?mode=dev changes nothing", async () => {
    const told = openIssue(app, alice, repo, {
      title: "List test: not picked up yet",
      body: "waits for the crew",
    });
    if (!told.ok) throw new Error(String(told.error));

    const page = await (await get("/alice/notes/issues")).text();
    expect(page).toContain("List test: not picked up yet");
    expect(page).toContain('data-word="told"');
    expect(page).not.toContain("Clear filters");
    expect(page).not.toContain('name="label"');
    expect(page).not.toContain(`>#${told.value.number} opened`);
    expect(page).toContain(`href="/alice/notes/issues?word=told"`);

    const filtered = await (await get("/alice/notes/issues?word=told")).text();
    expect(filtered).toContain("List test: not picked up yet");
    const other = await (await get("/alice/notes/issues?word=shipped")).text();
    expect(other).not.toContain("List test: not picked up yet");

    // There is no second list behind the mode: the cookie and the escape
    // hatch both answer the same rows in the same words.
    for (const dev of [
      await get("/alice/notes/issues", { cookie: `${cookie}; forge_mode=dev` }),
      await get("/alice/notes/issues?mode=dev"),
    ]) {
      expect(dev.status).toBe(200);
      const text = await dev.text();
      expect(text).toContain("List test: not picked up yet");
      expect(text).toContain('data-word="told"');
      expect(text).not.toContain(`>#${told.value.number} opened`);
      expect(text).not.toContain("See dev's list");
    }
  });

  test("every change is the one pull list, in the studio's own words; the word filter narrows it, and ?mode=dev changes nothing", async () => {
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/list-change",
      base: "main",
      message: "List change",
      files: [{ path: "LIST_CHANGE.md", content: "a change\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "List test: a green change",
      body: "",
      baseBranch: "main",
      headBranch: "feature/list-change",
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
    finishRun(app.db, check.id, { state: "ok", summary: "check passed" });

    const page = await (await get("/alice/notes/pulls")).text();
    expect(page).toContain("List test: a green change");
    expect(page).toContain('data-word="look"');
    expect(page).not.toContain(`${pull.headBranch} &rarr; ${pull.baseBranch}`);
    expect(page).not.toContain(`${pull.headBranch}`);

    const filtered = await (await get("/alice/notes/pulls?word=look")).text();
    expect(filtered).toContain("List test: a green change");
    const other = await (await get("/alice/notes/pulls?word=shipped")).text();
    expect(other).not.toContain("List test: a green change");

    for (const dev of [
      await get("/alice/notes/pulls", { cookie: `${cookie}; forge_mode=dev` }),
      await get("/alice/notes/pulls?mode=dev"),
    ]) {
      expect(dev.status).toBe(200);
      const text = await dev.text();
      expect(text).toContain("List test: a green change");
      expect(text).toContain('data-word="look"');
      expect(text).not.toContain(pull.headBranch);
      expect(text).not.toContain("See dev's list");
    }
    // A green pull left open now asks the front door too (#208) — close it
    // so it does not linger into a later test's own count of asks.
    expect(setIssueState(app, alice, repo, pull, "closed").ok).toBe(true);
  });

  test("every run is the run list in the studio's own words; the word filter narrows it, and ?mode=dev renders today's list", async () => {
    const scout = getUserByName(app.db, "scout")!;
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      actorId: scout.id,
      reason: "assigned",
    });
    claimRun(app.db, run.id);

    const page = await (await get("/alice/notes/runs")).text();
    expect(page).toContain('data-word="working"');
    expect(page).toContain(`href="/alice/notes/runs/${run.id}"`);

    const filtered = await (await get("/alice/notes/runs?word=working")).text();
    expect(filtered).toContain(`href="/alice/notes/runs/${run.id}"`);
    const other = await (await get("/alice/notes/runs?word=shipped")).text();
    expect(other).not.toContain(`href="/alice/notes/runs/${run.id}"`);

    // One list (#629): the cookie and the query both answer it.
    finishRun(app.db, run.id, { state: "failed", summary: "boom" });
    for (const dev of [
      await get("/alice/notes/runs?word=stopped", {
        cookie: `${cookie}; forge_mode=dev`,
      }),
      await get("/alice/notes/runs?word=stopped&mode=dev"),
    ]) {
      const text = await dev.text();
      expect(text).toContain('data-word="stopped"');
      expect(text).toContain(`href="/alice/notes/runs/${run.id}"`);
      expect(text).not.toContain("See dev's list");
    }
    // Deploys and checks are one quiet link away, and `?kind=` keeps the
    // meaning a link to dev's list gave it.
    expect(page).toContain('href="/alice/notes/runs?kind=deploy"');
    expect(page).toContain('href="/alice/notes/runs?kind=check"');
    const deploys = await (await get("/alice/notes/runs?kind=deploy")).text();
    expect(deploys).not.toContain(`href="/alice/notes/runs/${run.id}"`);
    expect(deploys).toContain('href="/alice/notes/runs?kind=deploy&amp;word=told"');
  });

  test("issues, pulls and runs on a repository that is not an app are the same one list", async () => {
    const plain = await createRepo(app, alice, {
      name: "plainlists",
      visibility: "private",
      description: "no app here",
    });
    if (!plain.ok) throw new Error(String(plain.error));
    const told = openIssue(app, alice, plain.value, {
      title: "Plain list: an issue",
      body: "",
    });
    if (!told.ok) throw new Error(String(told.error));

    for (const mode of ["studio", "dev"]) {
      const viewer = `${cookie}; forge_mode=${mode}`;
      const issues = await (
        await get("/alice/plainlists/issues", { cookie: viewer })
      ).text();
      expect(issues).toContain("Plain list: an issue");
      expect(issues).toContain('data-word="told"');
      expect(issues).toContain(`href="/alice/plainlists/issues?word=told"`);
      expect(issues).toContain(
        `href="/alice/plainlists/tells/${told.value.number}"`,
      );
      expect(issues).not.toContain("See dev's list");

      const pulls = await (
        await get("/alice/plainlists/pulls", { cookie: viewer })
      ).text();
      expect(pulls).toContain(`href="/alice/plainlists/pulls?word=look"`);
      expect(pulls).not.toContain("See dev's list");
    }

    const runs = await (await get("/alice/plainlists/runs")).text();
    expect(runs).toContain(`href="/alice/plainlists/runs?word=working"`);
    expect(runs).not.toContain("See dev's list");
  });

  test("/tells and /changes are the studio's own doors onto the same lists /issues and /pulls reach — same words, same filter, same paging", async () => {
    const told = openIssue(app, alice, repo, {
      title: "Door test: a tell",
      body: "reached through /tells too",
    });
    if (!told.ok) throw new Error(String(told.error));

    const viaIssues = await (await get("/alice/notes/issues")).text();
    const viaTells = await (await get("/alice/notes/tells")).text();
    expect(viaTells).toContain("Door test: a tell");
    expect(viaTells).toContain('data-word="told"');
    // Self-links (the word filter, paging) follow whichever door was used,
    // so a dev URL asked for in studio mode still answers exactly as it
    // does today.
    expect(viaTells).toContain(`href="/alice/notes/tells?word=told"`);
    expect(viaIssues).toContain(`href="/alice/notes/issues?word=told"`);

    const filtered = await (await get("/alice/notes/tells?word=told")).text();
    expect(filtered).toContain("Door test: a tell");
    const other = await (await get("/alice/notes/tells?word=shipped")).text();
    expect(other).not.toContain("Door test: a tell");

    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/door-test",
      base: "main",
      message: "Door test change",
      files: [{ path: "DOOR_TEST.md", content: "a change\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "Door test: a change",
      body: "",
      baseBranch: "main",
      headBranch: "feature/door-test",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const doorPull = opened.value;
    const doorCheck = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: doorPull.id,
      env: `pull-${doorPull.number}`,
      commitOid: doorPull.headOid,
      reason: "pull",
    });
    claimRun(app.db, doorCheck.id);
    finishRun(app.db, doorCheck.id, { state: "ok", summary: "check passed" });

    const viaPulls = await (await get("/alice/notes/pulls")).text();
    const viaChanges = await (await get("/alice/notes/changes")).text();
    expect(viaChanges).toContain("Door test: a change");
    expect(viaChanges).toContain('data-word="look"');
    expect(viaChanges).toContain(`href="/alice/notes/changes?word=look"`);
    expect(viaPulls).toContain(`href="/alice/notes/pulls?word=look"`);

    const changeFiltered = await (
      await get("/alice/notes/changes?word=look")
    ).text();
    expect(changeFiltered).toContain("Door test: a change");
    const changeOther = await (
      await get("/alice/notes/changes?word=shipped")
    ).text();
    expect(changeOther).not.toContain("Door test: a change");
    // A green pull left open now asks the front door too (#208) — close it
    // so it does not linger into a later test's own count of asks.
    expect(setIssueState(app, alice, repo, doorPull, "closed").ok).toBe(true);
  });

  test("/tells and /changes answer a dev-mode viewer, ?mode=dev, and a repository that is not an app with the same list, never a bounce", async () => {
    const plain = await createRepo(app, alice, {
      name: "doorlists",
      visibility: "private",
      description: "no app here",
    });
    if (!plain.ok) throw new Error(String(plain.error));

    for (const [path, viewer] of [
      ["/alice/notes/tells", `${cookie}; forge_mode=dev`],
      ["/alice/notes/changes", `${cookie}; forge_mode=dev`],
      ["/alice/notes/tells?mode=dev", `${cookie}; forge_mode=studio`],
      ["/alice/doorlists/tells", cookie],
      ["/alice/doorlists/changes", cookie],
    ] as const) {
      const res = await get(path, { cookie: viewer });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain(`href="${path.split("?")[0]}?word=`);
    }
  });

  test("the one list keeps what dev's list could narrow by: labels as chips, and who has it, who opened it, a piece of the title, and the older ?state= address", async () => {
    const shelf = await createRepo(app, alice, {
      name: "facetlists",
      visibility: "private",
      description: "labels and narrowings",
    });
    if (!shelf.ok) throw new Error(String(shelf.error));
    const r = shelf.value;
    const bug = createLabel(app, alice, r, "bug", "d73a4a");
    if (!bug.ok) throw new Error(String(bug.error));
    const a = openIssue(app, alice, r, { title: "Facet: a broken thing", body: "" });
    const b = openIssue(app, alice, r, { title: "Facet: a wish", body: "" });
    const c = openIssue(app, alice, r, { title: "Facet: long done", body: "" });
    if (!a.ok || !b.ok || !c.ok) throw new Error("open failed");
    expect(setIssueLabels(app, alice, r, a.value, ["bug"]).ok).toBe(true);
    expect(assignIssue(app, alice, r, b.value, alice).ok).toBe(true);
    expect(setIssueState(app, alice, r, c.value, "closed").ok).toBe(true);

    const list = await (await get("/alice/facetlists/issues")).text();
    // The row wears its label, and the repository's labels narrow the list.
    expect(list).toContain('class="label lc-d73a4a">bug</span>');
    expect(list).toContain(`href="/alice/facetlists/issues?label=bug"`);
    expect(list).toContain(".lc-d73a4a{--label:#d73a4a}");
    expect(list).not.toContain("Facet: long done");

    const labelled = await (await get("/alice/facetlists/issues?label=bug")).text();
    expect(labelled).toContain("Facet: a broken thing");
    expect(labelled).not.toContain("Facet: a wish");
    // The chip in force clears itself, and a word keeps the label.
    expect(labelled).toMatch(
      /href="\/alice\/facetlists\/issues"\s+aria-current="true"/,
    );
    expect(labelled).toContain(`href="/alice/facetlists/issues?word=told&amp;label=bug"`);

    const mine = await (await get("/alice/facetlists/issues?assignee=alice")).text();
    expect(mine).toContain("Facet: a wish");
    expect(mine).not.toContain("Facet: a broken thing");
    expect(mine).toContain("alice has it ✕");

    const titled = await (await get("/alice/facetlists/issues?q=wish")).text();
    expect(titled).toContain("Facet: a wish");
    expect(titled).not.toContain("Facet: a broken thing");
    expect(titled).toContain("wish in the title ✕");

    const bySomeone = await (await get("/alice/facetlists/issues?author=nobody")).text();
    expect(bySomeone).not.toContain("Facet: a wish");
    expect(bySomeone).toContain("nobody opened it ✕");

    // `?state=closed` from an older link still means what it said.
    const closed = await (await get("/alice/facetlists/issues?state=closed")).text();
    expect(closed).toContain("Facet: long done");
    expect(closed).not.toContain("Facet: a wish");
    // Closed with nothing merged is not dropped from the list: it reads
    // done, under shipped, where whoever closed it would look.
    const shipped = await (await get("/alice/facetlists/issues?word=shipped")).text();
    expect(shipped).toContain("Facet: long done");
    expect(shipped).toContain('data-word="done"');
    const all = await (await get("/alice/facetlists/issues?state=all")).text();
    expect(all).toContain("Facet: long done");
    expect(all).toContain("Facet: a wish");
  });

  test("the list's one verb besides opening a row is compose, for a signed-in person only, in the repository's own words", async () => {
    const plain = await createRepo(app, alice, {
      name: "composelists",
      visibility: "public",
      description: "no app here",
    });
    if (!plain.ok) throw new Error(String(plain.error));

    const signedIn = await (await get("/alice/composelists/issues")).text();
    expect(signedIn).toContain('href="/alice/composelists/issues/new"');
    expect(signedIn).toContain("New issue");
    const app_ = await (await get("/alice/notes/issues")).text();
    expect(app_).toContain('href="/alice/notes/issues/new"');
    expect(app_).toContain("Tell the crew");

    const anon = await (
      await fetch(`${base}/alice/composelists/issues`, { redirect: "manual" })
    ).text();
    expect(anon).not.toContain('href="/alice/composelists/issues/new"');
    // A stranger on a public repository can still report a problem.
    expect(anon).toContain('href="/alice/composelists/report"');
    // Someone signed in composes instead: no visible report link (the page's
    // head still names the report path for agents that read it).
    expect(signedIn).not.toMatch(
      /<a\b[^>]*href="\/alice\/composelists\/report"/,
    );
    // The pull list has no compose of its own: a change starts from a branch.
    const pulls = await (await get("/alice/composelists/pulls")).text();
    expect(pulls).not.toContain('href="/alice/composelists/pulls/new"');
  });

  test("a reader without access gets the forge's not-found on /tells and /changes, exactly as /issues and /pulls", async () => {
    const anonTells = await fetch(`${base}/alice/notes/tells`, {
      headers: { cookie: "forge_mode=studio" },
      redirect: "manual",
    });
    expect(anonTells.status).toBe(404);

    const anonChanges = await fetch(`${base}/alice/notes/changes`, {
      headers: { cookie: "forge_mode=studio" },
      redirect: "manual",
    });
    expect(anonChanges.status).toBe(404);
  });

  test("/tells/:number and /changes/:number reach the same pages /issues/:number and /pulls/:number reach — one page, the same anchors, and forms that still post to dev's own address", async () => {
    const told = openIssue(app, alice, repo, {
      title: "Door test: one tell",
      body: "reached through /tells/:number too",
    });
    if (!told.ok) throw new Error(String(told.error));
    const n = told.value.number;

    const viaTell = await get(`/alice/notes/tells/${n}`);
    expect(viaTell.status).toBe(200);
    const tellHtml = await viaTell.text();
    const viaIssue = await (await get(`/alice/notes/issues/${n}`)).text();
    // The same page, never a second copy of the markup.
    expect(tellHtml).toContain("Door test: one tell");
    expect(tellHtml).toContain('data-word="told"');
    // Still waiting, nobody assigned: the one case the line is true (#214).
    expect(tellHtml).toContain("nobody has it yet");
    expect(viaIssue).toContain('data-word="told"');
    // The write surface does not move with the noun: the reply, the close
    // and every Details form still point at /issues/:number.
    expect(tellHtml).toContain(`action="/alice/notes/issues/${n}/comments"`);
    expect(tellHtml).toContain(`action="/alice/notes/issues/${n}/assignee"`);
    // An anchor into the conversation still lands — the composer is on the
    // page either door was used.
    expect(tellHtml).toContain('id="comment-body"');

    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/one-change-door",
      base: "main",
      message: "One change door",
      files: [{ path: "ONE_DOOR.md", content: "a change\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "Door test: one change",
      body: "",
      baseBranch: "main",
      headBranch: "feature/one-change-door",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const p = opened.value.number;

    const viaChange = await get(`/alice/notes/changes/${p}`);
    expect(viaChange.status).toBe(200);
    const changeHtml = await viaChange.text();
    expect(changeHtml).toContain("Door test: one change");
    // The studio's change, not dev's diff.
    expect(changeHtml).not.toContain("diff-table");
    expect(changeHtml).toContain(`action="/alice/notes/pulls/${p}/comments"`);
    expect(changeHtml).toContain(`href="/alice/notes/pulls/${p}?mode=dev"`);
    expect(changeHtml).toContain('id="comment-body"');

    // Dev's own addresses answer the studio's pages where they stand — a
    // link already written to one is never bounced anywhere.
    const stillIssue = await get(`/alice/notes/issues/${n}`);
    expect(stillIssue.status).toBe(200);
    const stillPull = await get(`/alice/notes/pulls/${p}`);
    expect(stillPull.status).toBe(200);

    // The three lists, the app page and the search box all hand out the
    // studio's noun, so a person is never given two addresses for one thing.
    const tells = await (await get("/alice/notes/tells")).text();
    expect(tells).toContain(`href="/alice/notes/tells/${n}"`);
    const changes = await (await get("/alice/notes/changes")).text();
    expect(changes).toContain(`href="/alice/notes/changes/${p}"`);
    const appPage = await (await get("/alice/notes")).text();
    expect(appPage).toContain(`href="/alice/notes/changes/${p}"`);
    const search = await (await get("/search?q=Door+test")).text();
    expect(search).toContain(`/alice/notes/tells/${n}`);
    expect(search).toContain(`/alice/notes/changes/${p}`);
    // The palette's remote rows are folded in the browser; the index tells
    // the script which mode it is in, so it folds the same nouns.
    expect(appPage).toContain('"studio":true');
  });

  test("/tells/:number answers a dev-mode viewer, ?mode=dev, and a repository that is not an app with the same page, never a bounce", async () => {
    const told = openIssue(app, alice, repo, { title: "Door test: dev's way" });
    if (!told.ok) throw new Error(String(told.error));
    const n = told.value.number;

    for (const res of [
      await get(`/alice/notes/tells/${n}`, {
        cookie: `${cookie}; forge_mode=dev`,
      }),
      await get(`/alice/notes/tells/${n}?mode=dev`),
    ]) {
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Door test: dev");
    }

    const plain = await createRepo(app, alice, {
      name: "doorpages",
      visibility: "private",
      description: "no app here",
    });
    if (!plain.ok) throw new Error(String(plain.error));
    const plainTold = openIssue(app, alice, plain.value, {
      title: "Not an app",
    });
    if (!plainTold.ok) throw new Error(String(plainTold.error));
    const plainTell = await get(
      `/alice/doorpages/tells/${plainTold.value.number}`,
    );
    expect(plainTell.status).toBe(200);
    expect(await plainTell.text()).toContain("Not an app");
  });

  test("a reader without access gets the forge's not-found on /tells/:number and /changes/:number, exactly as /issues/:number and /pulls/:number", async () => {
    const told = openIssue(app, alice, repo, { title: "Door test: private" });
    if (!told.ok) throw new Error(String(told.error));
    const n = told.value.number;

    const anonTell = await fetch(`${base}/alice/notes/tells/${n}`, {
      headers: { cookie: "forge_mode=studio" },
      redirect: "manual",
    });
    expect(anonTell.status).toBe(404);
    const anonIssue = await fetch(`${base}/alice/notes/issues/${n}`, {
      headers: { cookie: "forge_mode=studio" },
      redirect: "manual",
    });
    expect(anonIssue.status).toBe(anonTell.status);

    // A number that is not a tell is not a tell at either address, and a
    // change's number is not one under the tell's own noun.
    const missing = await get("/alice/notes/tells/99999");
    expect(missing.status).toBe(404);
    const anonChange = await fetch(`${base}/alice/notes/changes/1`, {
      headers: { cookie: "forge_mode=studio" },
      redirect: "manual",
    });
    expect(anonChange.status).toBe(404);
  });

  test("a reader without access gets the forge's not-found on a tell, exactly as dev", async () => {
    const told = openIssue(app, alice, repo, { title: "Private work" });
    if (!told.ok) throw new Error(String(told.error));
    const anon = await fetch(
      `${base}/alice/notes/issues/${told.value.number}`,
      { headers: { cookie: "forge_mode=studio" }, redirect: "manual" },
    );
    expect(anon.status).toBe(404);
  });

  test("/apps in the studio is the shelf, not dev's table: an app the viewer can land, never one they cannot, and no dev table markup; ?mode=dev is unchanged", async () => {
    const bob = await createUser(app.db, { trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!bob.ok) throw new Error(bob.error);
    const hidden = await createRepo(app, bob.value, {
      name: "hidden",
      visibility: "private",
      description: "bob's own, not alice's crew",
    });
    if (!hidden.ok) throw new Error(String(hidden.error));
    const seededHidden = await commitToBranch(app, bob.value, hidden.value, {
      message: "Start",
      files: [
        {
          path: "package.json",
          content:
            '{"name":"hidden","scripts":{"start":"bun run server.ts"}}\n',
        },
        {
          path: "server.ts",
          content:
            "Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('ok') });\n",
        },
      ],
    });
    if (!seededHidden.ok) throw new Error(JSON.stringify(seededHidden.error));
    const enabledHidden = await enableApp(app, bob.value, hidden.value, {
      slug: "hidden",
    });
    if (!enabledHidden.ok) throw new Error(String(enabledHidden.error));
    const bobCookie = (
      (
        await fetch(`${base}/signin`, {
          method: "POST",
          body: new URLSearchParams({
            username: "bob",
            password: "a-good-passphrase",
          }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
    const bobGet = (path: string, extra: Record<string, string> = {}) =>
      fetch(`${base}${path}`, {
        headers: { cookie: `${bobCookie}; forge_mode=studio`, ...extra },
        redirect: "manual",
      });

    // Bob can land his own app, but alice never crewed him onto "notes" —
    // private and none of his — so the shelf omits it.
    const studio = await (await bobGet("/apps")).text();
    expect(studio).toContain('href="/bob/hidden"');
    expect(studio).not.toContain('href="/alice/notes"');
    expect(studio).not.toContain("not serving");
    expect(studio).toContain('href="/apps?live=1"');

    // One list (#630): dev's table is gone, and the cookie and the query
    // both answer the shelf.
    for (const dev of [
      await bobGet("/apps", { cookie: `${bobCookie}; forge_mode=dev` }),
      await bobGet("/apps?mode=dev"),
    ]) {
      const text = await dev.text();
      expect(text).toContain('href="/apps?live=1"');
      expect(text).not.toContain('href="/alice/notes"');
      expect(text).not.toContain("Repositories that run.");
    }
  });

  test("clicking your own name in the studio lands on /:owner, which leads with your apps on the shelf and New app as the primary action; dev mode is unchanged, and a stranger never sees a private one", async () => {
    const studio = await (await get("/alice")).text();
    expect(studio).toContain("<h2>Apps</h2>");
    expect(studio).toContain('href="/alice/notes"');
    expect(studio).toContain("not running");
    expect(studio).toContain('href="/apps/new?owner=alice"');
    // The repository list stays reachable, filter and all — nothing disappears.
    expect(studio).toContain("data-search-input");
    expect(studio).toContain("notes");

    const dev = await (
      await get("/alice", { cookie: `${cookie}; forge_mode=dev` })
    ).text();
    expect(dev).not.toContain("<h2>Apps</h2>");
    expect(dev).not.toContain('href="/apps/new?owner=alice"');
    expect(dev).not.toContain("not running");

    const carol = await createUser(app.db, { trusted: true,
      username: "carol",
      email: "carol@forge.local",
      password: "a-good-passphrase",
    });
    if (!carol.ok) throw new Error(carol.error);
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
    const stranger = await (
      await fetch(`${base}/alice`, {
        headers: { cookie: `${carolCookie}; forge_mode=studio` },
        redirect: "manual",
      })
    ).text();
    expect(stranger).not.toContain('href="/alice/notes"');
    expect(stranger).toContain("No apps yet");
    expect(stranger).not.toContain('href="/apps/new?owner=alice"');
  });

  test("signed out in studio, / leads with the public apps that are serving — their look, not a private one's", async () => {
    // A second app, public, with a picture of its production. "notes" stays
    // private, so its presence (or absence) is the negative case below.
    const madePublic = await createRepo(app, alice, {
      name: "beacon",
      visibility: "public",
      description: "a lighthouse in the fog",
    });
    if (!madePublic.ok) throw new Error(String(madePublic.error));
    const beacon = madePublic.value;
    const seededPublic = await commitToBranch(app, alice, beacon, {
      message: "Start",
      files: [
        {
          path: "package.json",
          content:
            '{"name":"beacon","scripts":{"start":"bun run server.ts"}}\n',
        },
        {
          path: "server.ts",
          content:
            "Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('ok') });\n",
        },
      ],
    });
    if (!seededPublic.ok) throw new Error(JSON.stringify(seededPublic.error));
    const enabledPublic = await enableApp(app, alice, beacon, {
      slug: "beacon",
    });
    if (!enabledPublic.ok) throw new Error(String(enabledPublic.error));

    // A look for each app's production, so the picture route has something
    // real to answer for and refuse.
    const dropLook = (appId: string, env: "production", commit: string) => {
      const rel = join("looks", appId, `${env}-thumb.png`);
      const abs = join(app.config.dataDir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, PNG);
      return recordLook(app.db, {
        appId,
        env,
        commitOid: commit,
        kind: "thumb",
        path: rel,
      });
    };
    const beaconApp = getAppByRepo(app.db, beacon.id)!;
    const notesApp = getAppByRepo(app.db, repo.id)!;
    dropLook(beaconApp.id, "production", seededPublic.value.commitOid);
    dropLook(notesApp.id, "production", "0".repeat(40));

    // Signed out, with the studio cookie: the public app's name, its look,
    // and Sign in / Create an account — never the private one.
    const done = await serving(app, servers);
    const anon = await (
      await fetch(`${base}/`, { headers: { cookie: "forge_mode=studio" } })
    ).text();
    expect(anon).toContain("beacon");
    expect(anon).toContain("a lighthouse in the fog");
    expect(anon).toContain(
      `/looks/production/${seededPublic.value.commitOid}/thumb.png`,
    );
    expect(anon).toContain('href="/signin"');
    expect(anon).toContain('href="/signup"');
    expect(anon).not.toContain(">notes<");
    expect(anon).not.toContain("<h1>Your code, your machine.</h1>");

    // The private app's picture 404s for a stranger — asserted, not assumed.
    const privateLook = await fetch(
      `${base}/alice/notes/looks/production/${"0".repeat(40)}/thumb.png`,
      { headers: { cookie: "forge_mode=studio" } },
    );
    expect(privateLook.status).toBe(404);
    // The public one's does not.
    const publicLook = await fetch(
      `${base}/alice/beacon/looks/production/${seededPublic.value.commitOid}/thumb.png`,
      { headers: { cookie: "forge_mode=studio" } },
    );
    expect(publicLook.status).toBe(200);

    // `?mode=dev` answers a stranger with the same door: the dev landing
    // folded into it (#396).
    const dev = await (
      await fetch(`${base}/?mode=dev`, {
        headers: { cookie: "forge_mode=studio" },
      })
    ).text();
    expect(dev).toContain("<h1>Apps, live.</h1>");
    expect(dev).toContain("a lighthouse in the fog");
    expect(dev).not.toContain("<h1>Your code, your machine.</h1>");
    await done();
  });

  test("the front door's tile is the thumb, not the full desktop picture, when both exist (#287)", async () => {
    const created = await createRepo(app, alice, {
      name: "tinytile",
      visibility: "public",
      description: "picked its own thumb",
    });
    if (!created.ok) throw new Error(String(created.error));
    const seeded = await commitToBranch(app, alice, created.value, {
      message: "Start",
      files: [
        {
          path: "package.json",
          content:
            '{"name":"tinytile","scripts":{"start":"bun run server.ts"}}\n',
        },
        {
          path: "server.ts",
          content:
            "Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('ok') });\n",
        },
      ],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, alice, created.value, {
      slug: "tinytile",
    });
    if (!enabled.ok) throw new Error(String(enabled.error));
    const record = getAppByRepo(app.db, created.value.id)!;
    const commit = seeded.value.commitOid;
    const drop = (kind: "desktop" | "thumb") => {
      const rel = join("looks", record.id, `production-${kind}.png`);
      const abs = join(app.config.dataDir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, PNG);
      recordLook(app.db, {
        appId: record.id,
        env: "production",
        commitOid: commit,
        kind,
        path: rel,
      });
    };
    drop("desktop");
    drop("thumb");

    const done = await serving(app, servers);
    const anon = await (
      await fetch(`${base}/`, { headers: { cookie: "forge_mode=studio" } })
    ).text();
    await done();
    const tile = anon
      .split("<img")
      .find((chunk) =>
        chunk.includes(
          `/${created.value.ownerName}/${created.value.name}/looks/`,
        ),
      );
    expect(tile).toBeDefined();
    expect(tile).toContain(`/looks/production/${commit}/thumb.png`);
    expect(tile).toContain('width="640"');
    expect(tile).toContain('height="400"');
  });

  test("the front door leads with apps the viewer can write, never a stranger's public one — but /apps still lists it, owner named", async () => {
    // A public app of alice's own, distinct from "notes" (private) and
    // "beacon" (made public by an earlier test) — self-contained so this
    // test does not lean on another test's state.
    const madePublic = await createRepo(app, alice, {
      name: "lighthouse",
      visibility: "public",
      description: "everybody can see this one",
    });
    if (!madePublic.ok) throw new Error(String(madePublic.error));
    const seeded = await commitToBranch(app, alice, madePublic.value, {
      message: "Start",
      files: [
        {
          path: "package.json",
          content:
            '{"name":"lighthouse","scripts":{"start":"bun run server.ts"}}\n',
        },
        {
          path: "server.ts",
          content:
            "Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('ok') });\n",
        },
      ],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, alice, madePublic.value, {
      slug: "lighthouse",
    });
    if (!enabled.ok) throw new Error(String(enabled.error));

    // Erin just signed up: no apps of her own, but the forge already has a
    // public one.
    const erin = await createUser(app.db, { trusted: true,
      username: "erin",
      email: "erin@forge.local",
      password: "a-good-passphrase",
    });
    if (!erin.ok) throw new Error(erin.error);
    const erinCookie = (
      (
        await fetch(`${base}/signin`, {
          method: "POST",
          body: new URLSearchParams({
            username: "erin",
            password: "a-good-passphrase",
          }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
    const erinGet = (path: string) =>
      fetch(`${base}${path}`, {
        headers: { cookie: `${erinCookie}; forge_mode=studio` },
        redirect: "manual",
      });

    // Erin's front door: the empty state and New app, never alice's public
    // app — #69's case, finally reachable.
    const erinHome = await (await erinGet("/")).text();
    expect(erinHome).toContain("No apps yet");
    expect(erinHome).toContain('href="/apps/new"');
    expect(erinHome).toContain('href="/?mode=dev"');
    expect(erinHome).not.toContain('href="/alice/lighthouse"');
    expect(erinHome).not.toContain("tell the crew something");

    // Alice's own front door still leads with it.
    const aliceHome = await (await get("/")).text();
    expect(aliceHome).toContain('href="/alice/lighthouse"');

    // /apps hides nothing: both see it, and it names its owner since neither
    // request is alice's own view of her own row — erin's outright, and
    // even alice's own listing spells it the same way for every row beside
    // her own.
    const erinApps = await (await erinGet("/apps")).text();
    expect(erinApps).toContain('href="/alice/lighthouse"');
    expect(erinApps).toContain('<span class="muted">alice/</span>lighthouse');

    const aliceApps = await (await get("/apps")).text();
    expect(aliceApps).toContain('href="/alice/lighthouse"');
  });

  test("a forge with no public apps opens on the studio's door with an empty shelf, never dev's git pitch — at every old landing URL (#396)", async () => {
    const dataDir2 = await mkdtemp(join(tmpdir(), "forge-studio-empty-"));
    const app2 = createApp({ dataDir: dataDir2, port: 0 });
    const servers2 = await serve(app2);
    try {
      // A public repository that is not an app is not on the shelf.
      const owner = await createUser(app2.db, { trusted: true,
        username: "olga",
        email: "olga@forge.local",
        password: "a-good-passphrase",
      });
      if (!owner.ok) throw new Error(owner.error);
      const plain = await createRepo(app2, owner.value, {
        name: "just-code",
        visibility: "public",
      });
      if (!plain.ok) throw new Error(String(plain.error));
      // The landing's old addresses: the default, each mode's cookie, and
      // the `?mode=dev` escape hatch.
      for (const [path, cookie] of [
        ["/", ""],
        ["/", "forge_mode=studio"],
        ["/", "forge_mode=dev"],
        ["/?mode=dev", ""],
        ["/?mode=studio", "forge_mode=dev"],
      ] as const) {
        const response = await fetch(`${servers2.url}${path}`, {
          headers: { cookie },
          redirect: "manual",
        });
        expect(response.status).toBe(200);
        const body = await response.text();
        expect(body).toContain("<h1>Apps, live.</h1>");
        expect(body).toContain("Nothing public is up yet");
        expect(body).toContain('href="/signup"');
        expect(body).toContain('href="/signin"');
        expect(body).not.toContain("<h1>Your code, your machine.</h1>");
        expect(body).not.toContain("Public repositories");
        expect(body).not.toContain(`href="/olga/just-code"`);
      }
    } finally {
      servers2.stop();
      app2.close();
      await rm(dataDir2, { recursive: true, force: true });
    }
  });

  test("the door reads public apps, not a window of the newest repositories, and shows only the live ones (#288, #686)", async () => {
    const dataDir2 = await mkdtemp(join(tmpdir(), "forge-studio-door-"));
    const app2 = createApp({ dataDir: dataDir2, port: 0 });
    const servers2 = await serve(app2);
    try {
      const made = await createUser(app2.db, { trusted: true,
        username: "pia",
        email: "pia@forge.local",
        password: "a-good-passphrase",
      });
      if (!made.ok) throw new Error(made.error);
      const pia = made.value;
      const appOf = async (name: string) => {
        const created = await createRepo(app2, pia, {
          name,
          visibility: "public",
        });
        if (!created.ok) throw new Error(String(created.error));
        const enabled = await enableApp(app2, pia, created.value, {
          slug: name,
        });
        if (!enabled.ok) throw new Error(String(enabled.error));
        return getAppByRepo(app2.db, created.value.id)!;
      };
      const older = await appOf("older");
      const quiet = await appOf("quiet");
      // More public plain repositories than the old window held, all newer
      // than the apps.
      for (let n = 0; n < 25; n++) {
        const r = await createRepo(app2, pia, {
          name: `plain-${n}`,
          visibility: "public",
        });
        if (!r.ok) throw new Error(String(r.error));
      }
      // Each with a picture, so only liveness decides.
      for (const record of [older, quiet]) {
        mkdirSync(join(dataDir2, "looks", record.id), { recursive: true });
        writeFileSync(join(dataDir2, "looks", record.id, "thumb.png"), PNG);
        recordLook(app2.db, {
          appId: record.id,
          env: "production",
          commitOid: "0".repeat(40),
          kind: "thumb",
          path: `looks/${record.id}/thumb.png`,
        });
      }
      // `older` is serving, `quiet` is stopped: a stranger is shown what is
      // up, never what is down.
      const done = await serving(app2, servers2, (record) =>
        record.id === older.id ? "running" : "stopped",
      );
      try {
        const body = await (await fetch(`${servers2.url}/`)).text();
        expect(body).toContain('href="/pia/older"');
        expect(body).not.toContain('href="/pia/quiet"');
        expect(body).not.toContain('href="/pia/plain-0"');
      } finally {
        await done();
      }
    } finally {
      servers2.stop();
      app2.close();
      await rm(dataDir2, { recursive: true, force: true });
    }
  });
  test("a change on <crew>/<number>-<slug> links the tell it answers, and says so when that tell is closed; other branches show no tell", async () => {
    const told = openIssue(app, alice, repo, {
      title: "Answered tell",
      body: "",
    });
    if (!told.ok) throw new Error(String(told.error));
    const n = told.value.number;
    const open = async (branch: string, title: string) => {
      const c = await commitToBranch(app, alice, repo, {
        branch,
        base: "main",
        message: title,
        files: [{ path: `${branch.replace(/\//g, "_")}.md`, content: "x\n" }],
      });
      if (!c.ok) throw new Error(JSON.stringify(c.error));
      const o = await openPull(app, alice, repo, {
        title,
        body: "",
        baseBranch: "main",
        headBranch: branch,
      });
      if (!o.ok) throw new Error(String(o.error));
      return o.value;
    };
    const answering = await open(`scout/${n}-answer-it`, "Answers the tell");
    const stray = await open("scout/99999-nothing", "Answers nothing");
    const own = await open("revert-22", "A person's branch");

    const list = await (await get("/alice/notes/changes")).text();
    const rowOf = (title: string) => {
      const at = list.indexOf(title);
      return list.slice(at, list.indexOf("</a>", at + 400) + 4);
    };
    expect(rowOf("Answers the tell")).toContain(`href="/alice/notes/tells/${n}"`);
    expect(rowOf("Answers the tell")).not.toContain("already done");
    expect(rowOf("Answers nothing")).not.toContain("for tell");
    expect(rowOf("A person's branch")).not.toContain("for tell");

    setIssueState(app, alice, repo, told.value, "closed");
    const closedList = await (await get("/alice/notes/changes")).text();
    expect(closedList).toContain("its tell is already done");
    const page = await (
      await get(`/alice/notes/changes/${answering.number}`)
    ).text();
    expect(page).toContain(`href="/alice/notes/tells/${n}"`);
    expect(page).toContain("its tell is already done");
    for (const p of [stray, own]) {
      const res = await get(`/alice/notes/changes/${p.number}`);
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain("for tell");
    }
  });
});

describe("an owner's page lists an app once, not once in each vocabulary (#221)", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-owner-once-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const signIn = async (username: string, password: string) =>
    (
      (
        await fetch(`${base}/signin`, {
          method: "POST",
          body: new URLSearchParams({ username, password }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;

  const occurrences = (haystack: string, needle: string): number =>
    haystack.split(needle).length - 1;

  test("a person with one app and one plain repository renders each once in the studio, and both together in one list in dev mode", async () => {
    const dan = await createUser(app.db, { trusted: true,
      username: "dan",
      email: "dan@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!dan.ok) throw new Error(dan.error);
    const cookie = await signIn("dan", "a-good-passphrase");

    const madeApp = await createRepo(app, dan.value, {
      name: "beacon",
      visibility: "public",
      description: "a lighthouse",
    });
    if (!madeApp.ok) throw new Error(String(madeApp.error));
    const appSeeded = await commitToBranch(app, dan.value, madeApp.value, {
      message: "Start",
      files: [{ path: "README.md", content: "hi\n" }],
    });
    if (!appSeeded.ok) throw new Error(JSON.stringify(appSeeded.error));
    const enabled = await enableApp(app, dan.value, madeApp.value, {
      slug: "beacon",
    });
    if (!enabled.ok) throw new Error(String(enabled.error));

    const madePlain = await createRepo(app, dan.value, {
      name: "scratch",
      visibility: "public",
      description: "not an app",
    });
    if (!madePlain.ok) throw new Error(String(madePlain.error));
    const plainSeeded = await commitToBranch(app, dan.value, madePlain.value, {
      message: "Start",
      files: [{ path: "README.md", content: "hi\n" }],
    });
    if (!plainSeeded.ok) throw new Error(JSON.stringify(plainSeeded.error));

    const studio = await (
      await fetch(`${base}/dan`, {
        headers: { cookie: `${cookie}; forge_mode=studio` },
        redirect: "manual",
      })
    ).text();
    expect(occurrences(studio, 'href="/dan/beacon"')).toBe(1);
    expect(occurrences(studio, 'href="/dan/scratch"')).toBe(1);
    expect(studio).toContain("<h2>Other repositories</h2>");

    const dev = await (
      await fetch(`${base}/dan`, {
        headers: { cookie: `${cookie}; forge_mode=dev` },
        redirect: "manual",
      })
    ).text();
    expect(occurrences(dev, 'href="/dan/beacon"')).toBe(1);
    expect(occurrences(dev, 'href="/dan/scratch"')).toBe(1);
    expect(dev).not.toContain("<h2>Apps</h2>");
    expect(dev).not.toContain("<h2>Other repositories</h2>");
  });

  test("an owner whose only repository is an app reads the empty list below as no other repositories, not as a bug", async () => {
    const eve = await createUser(app.db, { trusted: true,
      username: "eve",
      email: "eve@forge.local",
      password: "a-good-passphrase",
    });
    if (!eve.ok) throw new Error(eve.error);
    const cookie = await signIn("eve", "a-good-passphrase");

    const madeApp = await createRepo(app, eve.value, {
      name: "lighthouse",
      visibility: "public",
    });
    if (!madeApp.ok) throw new Error(String(madeApp.error));
    const seeded = await commitToBranch(app, eve.value, madeApp.value, {
      message: "Start",
      files: [{ path: "README.md", content: "hi\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, eve.value, madeApp.value, {
      slug: "lighthouse",
    });
    if (!enabled.ok) throw new Error(String(enabled.error));

    const studio = await (
      await fetch(`${base}/eve`, {
        headers: { cookie: `${cookie}; forge_mode=studio` },
        redirect: "manual",
      })
    ).text();
    expect(occurrences(studio, 'href="/eve/lighthouse"')).toBe(1);
    expect(studio).toContain("No other repositories");
    expect(studio).not.toContain("<h2>Other repositories</h2>");
  });

  test("an org's page draws the same way: its app once, its plain repository once, and Members/Teams unmoved", async () => {
    const fay = await createUser(app.db, { trusted: true,
      username: "fay",
      email: "fay@forge.local",
      password: "a-good-passphrase",
    });
    if (!fay.ok) throw new Error(fay.error);
    const cookie = await signIn("fay", "a-good-passphrase");

    const org = await createOrg(app, fay.value, "vega");
    if (!org.ok) throw new Error(org.error);

    const madeApp = await createRepo(app, fay.value, {
      name: "anvil",
      owner: "vega",
      visibility: "public",
    });
    if (!madeApp.ok) throw new Error(String(madeApp.error));
    const appSeeded = await commitToBranch(app, fay.value, madeApp.value, {
      message: "Start",
      files: [{ path: "README.md", content: "hi\n" }],
    });
    if (!appSeeded.ok) throw new Error(JSON.stringify(appSeeded.error));
    const enabled = await enableApp(app, fay.value, madeApp.value, {
      slug: "anvil",
    });
    if (!enabled.ok) throw new Error(String(enabled.error));

    const madePlain = await createRepo(app, fay.value, {
      name: "ledger",
      owner: "vega",
      visibility: "public",
    });
    if (!madePlain.ok) throw new Error(String(madePlain.error));
    const plainSeeded = await commitToBranch(app, fay.value, madePlain.value, {
      message: "Start",
      files: [{ path: "README.md", content: "hi\n" }],
    });
    if (!plainSeeded.ok) throw new Error(JSON.stringify(plainSeeded.error));

    const studio = await (
      await fetch(`${base}/vega`, {
        headers: { cookie: `${cookie}; forge_mode=studio` },
        redirect: "manual",
      })
    ).text();
    expect(occurrences(studio, 'href="/vega/anvil"')).toBe(1);
    expect(occurrences(studio, 'href="/vega/ledger"')).toBe(1);
    expect(studio).toContain('<h2 class="mt">Members</h2>');
    expect(studio).toContain('<h2 class="mt">Teams</h2>');

    const dev = await (
      await fetch(`${base}/vega`, {
        headers: { cookie: `${cookie}; forge_mode=dev` },
        redirect: "manual",
      })
    ).text();
    expect(occurrences(dev, 'href="/vega/anvil"')).toBe(1);
    expect(occurrences(dev, 'href="/vega/ledger"')).toBe(1);
  });
});

describe("every open pull's preview on the studio page", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let base: string;
  let cookie: string;
  let repo: Repo;

  const get = (path: string) =>
    fetch(`${base}${path}`, {
      headers: { cookie: `${cookie}; forge_mode=studio` },
      redirect: "manual",
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-studio-previews-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    runtime = new AppsRuntime(app, {
      domain: "studio-previews.test",
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 1,
    });
    await runtime.start();
    const a = await createUser(app.db, { trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
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
      name: "widget",
      visibility: "public",
      description: "",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, a.value, repo, {
      message: "Start",
      files: [
        {
          path: "package.json",
          content:
            '{"name":"widget","scripts":{"start":"bun run server.ts"}}\n',
        },
        {
          path: "server.ts",
          content:
            "Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('ok') });\n",
        },
      ],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, a.value, repo, { slug: "widget" });
    if (!enabled.ok) throw new Error(String(enabled.error));
  }, 30_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an open pull's preview host and open link render; none do once nothing is open", async () => {
    const alice = getUserByName(app.db, "alice")!;
    const before = await (await get("/alice/widget")).text();
    expect(before).not.toContain("<h2>Previews</h2>");

    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/x",
      base: repo.defaultBranch,
      message: "Add X",
      files: [{ path: "X.md", content: "x\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "Add X",
      body: "",
      baseBranch: repo.defaultBranch,
      headBranch: "feature/x",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;

    const page = await (await get("/alice/widget")).text();
    expect(page).toContain("<h2>Previews</h2>");
    expect(page).toContain(`href="/alice/widget/app/pull-${pull.number}/open"`);
    expect(page).toContain(`#${pull.number} Add X`);

    const merged = await mergePull(app, alice, repo, pull, "squash");
    expect(merged.ok).toBe(true);
    const after = await (await get("/alice/widget")).text();
    expect(after).not.toContain("<h2>Previews</h2>");
    expect(after).not.toContain(`pull-${pull.number}/open`);
  }, 30_000);

  test("a change's page names its preview's data as its own copy and gives the moment it was taken; production's card does not", async () => {
    const alice = getUserByName(app.db, "alice")!;
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/y",
      base: repo.defaultBranch,
      message: "Add Y",
      files: [{ path: "Y.md", content: "y\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "Add Y",
      body: "",
      baseBranch: repo.defaultBranch,
      headBranch: "feature/y",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    const record = getAppByRepo(app.db, repo.id)!;
    const env = `pull-${pull.number}` as const;

    const deadline = Date.now() + 30_000;
    while (
      Date.now() < deadline &&
      runtime.envStatus(record, env)?.state !== "running"
    )
      await Bun.sleep(100);
    expect(runtime.envStatus(record, env)?.state).toBe("running");

    const note = "its own copy of production's data, taken";

    const appPage = await (await get("/alice/widget")).text();
    expect(appPage).toContain(note);
    // Production's own card, above the previews list, never says it.
    const production = appPage.slice(0, appPage.indexOf("<h2>Previews</h2>"));
    expect(production).not.toContain(note);

    const changePage = await (
      await get(`/alice/widget/changes/${pull.number}`)
    ).text();
    expect(changePage).toContain("<h2>Preview</h2>");
    expect(changePage).toContain(note);
  }, 30_000);
});

/**
 * The studio home keeps itself current: Asks you, Your apps and On you are
 * each a live region — no second fragment endpoint, the same `studioHome`
 * render as the first paint, fetched again on a matching event and swapped
 * in place by `liveRegionsJs` (`src/web/client.ts`).
 */
describe("the studio home keeps itself current", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let repo: Repo;
  let cookie: string;
  let pull: Pull;
  let readme: Issue;

  const get = (extraCookie = "") =>
    fetch(`${base}/`, {
      headers: {
        cookie: `${cookie}${extraCookie}; forge_mode=studio`,
      },
      redirect: "manual",
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-studio-live-home-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, { trusted: true,
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
    const made = await createRepo(app, alice, {
      name: "signals",
      visibility: "private",
      description: "",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "s\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, alice, repo, { slug: "signals" });
    if (!enabled.ok) throw new Error(String(enabled.error));
    const scout = await createAgent(app, alice, { username: "scout" });
    if (!scout.ok) throw new Error(String(scout.error));
    expect(addToCrew(app, alice, repo, "scout").ok).toBe(true);
    const scoutUser = getUserByName(app.db, "scout")!;
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/x",
      base: "main",
      message: "Add x",
      files: [{ path: "x.md", content: "x\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, scoutUser, repo, {
      title: "Add x",
      body: "",
      baseBranch: "main",
      headBranch: "feature/x",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    pull = opened.value;
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

    const asked = openIssue(app, alice, repo, { title: "Write the README" });
    if (!asked.ok) throw new Error(String(asked.error));
    readme = asked.value;
    expect(assignIssue(app, alice, repo, readme, alice).ok).toBe(true);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("Your apps and On you are each a live region, with the security floor's headers", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    const home = await res.text();
    expect(home).toMatch(/id="live-apps"\s*\n?\s*data-live="/);
    expect(home).toMatch(/id="live-on-you"\s*\n?\s*data-live="/);
    expect(home).toContain("new EventSource('/events')");
    expect(home).toContain("Write the README");
  });

  test("each region on the home has an address of its own, answering with that region alone and 304 when it has not changed", async () => {
    const page = await (await get()).text();
    expect(page).toContain('data-live-src="/live/apps"');
    expect(page).toContain('data-live-src="/live/on-you"');

    const headers = { cookie: `${cookie}; forge_mode=studio` };
    const apps = await fetch(`${base}/live/apps`, { headers });
    expect(apps.status).toBe(200);
    const appsText = await apps.text();
    expect(appsText).toContain('id="live-apps"');
    expect(appsText).toContain(`${repo.name}`);
    expect(appsText).not.toContain("<html");
    const tag = apps.headers.get("etag");
    expect(tag).toMatch(/^"[0-9a-f]{16}"$/);
    const unchanged = await fetch(`${base}/live/apps`, {
      headers: { ...headers, "if-none-match": tag! },
    });
    expect(unchanged.status).toBe(304);

    const onYou = await fetch(`${base}/live/on-you`, { headers });
    expect(onYou.status).toBe(200);
    expect(await onYou.text()).toContain('id="live-on-you"');

    // Signed out, the regions are nobody's.
    expect((await fetch(`${base}/live/apps`)).status).toBe(404);
    expect((await fetch(`${base}/live/on-you`)).status).toBe(404);
  });

  test("a signed-out request gets a signed-out home: no per-viewer live regions, nothing of alice's", async () => {
    const res = await fetch(`${base}/`, {
      headers: { cookie: "forge_mode=studio" },
      redirect: "manual",
    });
    expect(res.status).toBe(200);
    const home = await res.text();
    expect(home).not.toContain('id="live-asks"');
    expect(home).not.toContain('id="live-on-you"');
    expect(home).not.toContain("Add x");
    expect(home).not.toContain("Write the README");
  });

  test("a card leaves On you once its issue closes", async () => {
    const before = await (await get()).text();
    expect(before).toContain("Write the README");

    const merged = await mergePull(app, alice, repo, pull, "squash");
    expect(merged.ok).toBe(true);
    expect(setIssueState(app, alice, repo, readme, "closed").ok).toBe(true);

    const after = await (await get()).text();
    expect(after).not.toContain("Write the README");
  });
});

/**
 * The studio head of an app that is not up: the same facts the App page
 * shows — why, the deploy that says the rest, and the way to try again.
 */
describe("the studio head says why the app is not up", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let repo: Repo;
  let record: AppRecord;
  let runtime: AppsRuntime;
  let deploy: string;
  let writer: string;
  let reader: string;

  const head = (cookie: string) =>
    fetch(`${base}/alice/notes`, {
      headers: { cookie: `${cookie}; forge_mode=studio` },
      redirect: "manual",
    }).then((r) => r.text());

  /** The home's own shelf row for this app — the badge issue #201 is about. */
  const shelfBadge = async (cookie: string): Promise<string> => {
    const home = await (
      await fetch(`${base}/`, {
        headers: { cookie: `${cookie}; forge_mode=studio` },
        redirect: "manual",
      })
    ).text();
    const at = home.indexOf('href="/alice/notes"');
    expect(at).toBeGreaterThan(-1);
    const start = home.lastIndexOf("<li>", at);
    const row = home.slice(start, home.indexOf("</li>", at) + 5);
    return row.match(/<span class="badge"[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? "";
  };

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

  /**
   * An environment as the runtime holds it, without running a deploy: the
   * page reads `runtime.status(record)`, and a real failure would mean a
   * real install and a real health timeout for a rendering test.
   */
  interface Slot {
    readonly app: AppRecord;
    readonly env: EnvName;
    readonly chain: Promise<void>;
    readonly restarts: number[];
    readonly live?: unknown;
    readonly deploying?: unknown;
    readonly lastError?: string;
    readonly lastRunId?: string;
    readonly lastErrorCommitOid?: string;
  }
  const put = (
    slot: Omit<Slot, "app" | "env" | "chain" | "restarts">,
  ): void => {
    (runtime as unknown as { envs: Map<string, Slot> }).envs.set(
      `${record.id}/production`,
      {
        app: record,
        env: "production",
        chain: Promise.resolve(),
        restarts: [],
        ...slot,
      },
    );
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-studio-notup-"));
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
    const a = await createUser(app.db, { trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    const b = await createUser(app.db, { trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    writer = await signIn("alice");
    reader = await signIn("bob");
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
    const enabled = await enableApp(app, a.value, repo, { slug: "notes" });
    if (!enabled.ok) throw new Error(String(enabled.error));
    record = getAppByRepo(app.db, repo.id)!;
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "deploy",
      env: "production",
      commitOid: seeded.value.commitOid,
      reason: "push",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, {
      state: "failed",
      summary: "the deploy failed",
    });
    deploy = run.id;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a failed production says what failed, links its deploy, and offers Redeploy to a writer only — and offers no live link to the host", async () => {
    put({
      lastError: "the deploy failed: <install> exited 1",
      lastRunId: deploy,
    });
    const mine = await head(writer);
    expect(mine).toContain("not up");
    // The error is the app's own output: shown, and escaped.
    expect(mine).toContain("the deploy failed: &lt;install&gt; exited 1");
    expect(mine).not.toContain("<install>");
    expect(mine).toContain(`href="/alice/notes/runs/${deploy}"`);
    expect(mine).toContain('action="/alice/notes/app/production/redeploy"');
    expect(mine).toContain('action="/alice/notes/app/production/stop"');
    expect(mine).not.toContain('href="/alice/notes/app/production/open"');
    expect(mine).toContain('title="The last deploy failed"');

    const theirs = await head(reader);
    expect(theirs).toContain("not up");
    expect(theirs).toContain("the deploy failed: &lt;install&gt; exited 1");
    expect(theirs).toContain(`href="/alice/notes/runs/${deploy}"`);
    expect(theirs).not.toContain("/app/production/redeploy");
    expect(theirs).not.toContain("/app/production/stop");
    expect(theirs).not.toContain('href="/alice/notes/app/production/open"');
  });

  // Issue #201: the shelf used to print the runtime's raw `EnvState` for a
  // failed or deploying production, disagreeing with the app's own head
  // above — which has always spoken the studio's five-ish words.
  test("a failed production reads 'not up' on the home shelf too, never the runtime's own word 'failed'", async () => {
    put({
      lastError: "the deploy failed: <install> exited 1",
      lastRunId: deploy,
    });
    expect(await shelfBadge(writer)).toBe("not up");
  });

  test("a stopped production says it is not running and offers Redeploy, not Stop — and no live link to the host", async () => {
    put({ lastRunId: deploy });
    const mine = await head(writer);
    expect(mine).toContain("not running");
    expect(mine).toContain('action="/alice/notes/app/production/redeploy"');
    expect(mine).not.toContain('action="/alice/notes/app/production/stop"');
    expect(mine).not.toContain('href="/alice/notes/app/production/open"');
    expect(mine).toContain('title="Not running"');
    expect(await shelfBadge(writer)).toBe("not running");
  });

  test("a deploying production says so where the button was, not a link to a host nothing is serving yet", async () => {
    put({
      deploying: { run: { id: deploy, commitOid: "0".repeat(40) } },
    });
    const mine = await head(writer);
    expect(mine).toContain("starting");
    expect(mine).not.toContain('href="/alice/notes/app/production/open"');
    expect(mine).toContain('title="Still deploying"');
    // The runtime's own word for this state is "deploying" — the shelf
    // says "starting" instead, same as the head above.
    expect(await shelfBadge(writer)).toBe("starting");
  });

  test("a serving app with red tests still reads as serving, with the failure in its own words, and is still open-able", async () => {
    put({
      live: {
        commitOid: "0".repeat(40),
        handle: { port: 4321 },
        runId: deploy,
        since: new Date(Date.now() - 60_000).toISOString(),
        testsFailed: "1 of 3 tests failed",
        manifest: { tty: null },
      },
    });
    const mine = await head(writer);
    expect(mine).toContain("serving · tests failed");
    expect(mine).not.toContain("not up");
    expect(mine).toContain("serving · tests failed: 1 of 3 tests failed");
    expect(mine).toContain('href="/alice/notes/app/production/open"');
    expect(await shelfBadge(writer)).toBe("serving · tests failed");
  });

  test("a newer push that failed to come up while an older deploy keeps serving: live, not plain green, both commits named, its run linked", async () => {
    const failed = createRun(app.db, {
      repoId: repo.id,
      kind: "deploy",
      env: "production",
      commitOid: "2".repeat(40),
      reason: "push",
    });
    claimRun(app.db, failed.id);
    finishRun(app.db, failed.id, {
      state: "failed",
      summary: "forge.json: JSON Parse error: Unexpected token '}'",
    });
    put({
      live: {
        commitOid: "1".repeat(40),
        handle: { port: 4321 },
        runId: deploy,
        since: new Date(Date.now() - 60_000).toISOString(),
        manifest: { tty: null },
      },
      lastError: "forge.json: JSON Parse error: Unexpected token '}'",
      lastRunId: failed.id,
      lastErrorCommitOid: "2".repeat(40),
    });
    const mine = await head(writer);
    // It answers — still "live", never "not up" — but not untroubled green.
    expect(mine).toContain("live");
    expect(mine).not.toContain("not up");
    expect(mine).toContain('href="/alice/notes/app/production/open"');
    // Both commits, named.
    expect(mine).toContain("1111111");
    expect(mine).toContain("2222222");
    expect(mine).toContain("did not come up");
    expect(mine).toContain(
      "forge.json: JSON Parse error: Unexpected token &#39;}&#39;",
    );
    // The failed run's log, one click away.
    expect(mine).toContain(`href="/alice/notes/runs/${failed.id}"`);
  });

  test("a clean deploy with no failure behind it is unchanged: plain live, no failed-run link", async () => {
    put({
      live: {
        commitOid: "1".repeat(40),
        handle: { port: 4321 },
        runId: deploy,
        since: new Date(Date.now() - 60_000).toISOString(),
        manifest: { tty: null },
      },
    });
    const mine = await head(writer);
    expect(mine).toContain("live");
    expect(mine).not.toContain("did not come up");
  });
});

/**
 * The studio app page's Terminal — the one door an operator has into what
 * is running. `terminalFor` (`src/actions/apps.ts`) is the single fact both
 * this page and the dev App page read; this only checks it is drawn (or
 * withheld) correctly, not recomputed.
 */
describe("the studio app page's terminal", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let repo: Repo;
  let record: AppRecord;
  let runtime: AppsRuntime;
  let writer: string;
  let reader: string;

  interface Slot {
    readonly app: AppRecord;
    readonly env: EnvName;
    readonly chain: Promise<void>;
    readonly restarts: number[];
    readonly live?: unknown;
  }
  const putLive = (tty: string | null): void => {
    (runtime as unknown as { envs: Map<string, Slot> }).envs.set(
      `${record.id}/production`,
      {
        app: record,
        env: "production",
        chain: Promise.resolve(),
        restarts: [],
        live: {
          commitOid: "a".repeat(40),
          handle: { port: 4321 },
          runId: "fake",
          since: new Date().toISOString(),
          manifest: { tty },
        },
      },
    );
  };

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

  const appPage = (cookie: string) =>
    fetch(`${base}/alice/beacon`, {
      headers: { cookie: `${cookie}; forge_mode=studio` },
      redirect: "manual",
    }).then((r) => r.text());

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-studio-terminal-"));
    app = createApp({ dataDir, port: 0, host: "forge.example" });
    app.config.sshPort = 2222;
    app.config.sshHostKey =
      "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    servers = await serve(app);
    base = servers.url;
    runtime = new AppsRuntime(app, {
      domain: "apps.test",
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 1,
    });
    const a = await createUser(app.db, { trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    const b = await createUser(app.db, { trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    writer = await signIn("alice");
    reader = await signIn("bob");
    const made = await createRepo(app, a.value, {
      name: "beacon",
      visibility: "public",
      description: "a light that stays on",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, a.value, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "beacon\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, a.value, repo, { slug: "beacon" });
    if (!enabled.ok) throw new Error(String(enabled.error));
    record = getAppByRepo(app.db, repo.id)!;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a writer sees the exact command and the host key; a reader sees neither", async () => {
    putLive("bun run src/tty.ts");
    const mine = await appPage(writer);
    expect(mine).toContain("ssh -p 2222 beacon@forge.example");
    expect(mine).toContain("host key SHA256:abcdefghijklmnopqrstuvwxyz");
    // Wrapped in the marker an email-scanning edge honours, so the
    // login@host in the command is never rewritten into a mailto: link —
    // and the command itself sits between the markers unchanged.
    expect(mine).toContain(
      "<!--email_off-->ssh -p 2222 beacon@forge.example<!--/email_off-->",
    );
    const theirs = await appPage(reader);
    expect(theirs).not.toContain("ssh -p 2222 beacon@forge.example");
    expect(theirs).not.toContain("The terminal is off");
  });

  test("an app with no tty says the terminal is off, to a writer only", async () => {
    putLive(null);
    const mine = await appPage(writer);
    expect(mine).toContain("The terminal is off");
    expect(mine).not.toContain("ssh -p 2222 beacon@forge.example");
    const theirs = await appPage(reader);
    expect(theirs).not.toContain("The terminal is off");
  });

  // Issue #283: a hosted forge (an app of another forge) defaults
  // FORGE_SSH_PORT to 0, so serve() never opens a listener — every app on
  // it declares a tty but has nothing to connect it to. The generic "The
  // terminal is off." leaves a reader with no idea why or what to do; this
  // asserts the line names FORGE_SSH_PORT instead, composed from the same
  // sshPort field the other tests here already pin (#77's ground) rather
  // than by shutting a real listener down.
  test("a hosted forge with no SSH listener says why, and names FORGE_SSH_PORT", async () => {
    putLive("bun run src/tty.ts");
    app.config.sshPort = 0;
    try {
      const mine = await appPage(writer);
      expect(mine).toContain("FORGE_SSH_PORT");
      expect(mine).not.toContain("ssh -p 2222 beacon@forge.example");
      expect(mine).not.toContain("The terminal is off.</p>");
    } finally {
      app.config.sshPort = 2222;
    }
  });
});

/**
 * GET /:owner/:name/app/state — the fragment the studio page's live client
 * fetches on a deploy run event, and swaps into `#app-head`/`#app-previews`
 * in place of a reload. It is authorized exactly as the studio page, and
 * renders from the same `appPanels` function the page's first paint does.
 */
describe("the app's live fragment: /:owner/:name/app/state", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let runtime: AppsRuntime;
  let repo: Repo;
  let record: AppRecord;
  let owner: string;
  let stranger: string;

  interface PreviewSlot {
    readonly app: AppRecord;
    readonly env: EnvName;
    readonly chain: Promise<void>;
    readonly restarts: number[];
    deploying?: unknown;
    live?: unknown;
    lastError?: string;
    lastRunId?: string;
  }
  const putEnv = (
    env: EnvName,
    slot: Omit<PreviewSlot, "app" | "env" | "chain" | "restarts">,
  ): void => {
    (runtime as unknown as { envs: Map<string, PreviewSlot> }).envs.set(
      `${record.id}/${env}`,
      { app: record, env, chain: Promise.resolve(), restarts: [], ...slot },
    );
  };

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

  const get = (path: string, cookie: string) =>
    fetch(`${base}${path}`, {
      headers: { cookie: `${cookie}; forge_mode=studio` },
      redirect: "manual",
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-studio-state-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    runtime = new AppsRuntime(app, {
      domain: "state.test",
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 1,
    });
    const a = await createUser(app.db, { trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    const c = await createUser(app.db, { trusted: true,
      username: "carol",
      email: "carol@forge.local",
      password: "a-good-passphrase",
    });
    if (!c.ok) throw new Error(c.error);
    owner = await signIn("alice");
    stranger = await signIn("carol");
    const made = await createRepo(app, a.value, {
      name: "vault",
      visibility: "private",
      description: "",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, a.value, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "v\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, a.value, repo, { slug: "vault" });
    if (!enabled.ok) throw new Error(String(enabled.error));
    record = getAppByRepo(app.db, repo.id)!;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("renders the head card for a viewer who may see it, with the security floor's headers; refuses one who may not, same as the page", async () => {
    const fragment = await get("/alice/vault/app/state", owner);
    expect(fragment.status).toBe(200);
    expect(fragment.headers.get("x-content-type-options")).toBe("nosniff");
    expect(fragment.headers.get("referrer-policy")).toBe("same-origin");
    const text = await fragment.text();
    expect(text).toContain('id="app-head"');
    expect(text).toContain('id="app-previews"');
    expect(text).toContain("not running");

    const page = await (await get("/alice/vault", owner)).text();
    expect(page).toContain("not running");

    const refusedFragment = await get("/alice/vault/app/state", stranger);
    expect(refusedFragment.status).toBe(404);
    const refusedPage = await get("/alice/vault", stranger);
    expect(refusedPage.status).toBe(404);
  });

  test("Now has an address of its own: the page's region names it, the fragment answers with the same region, and unchanged bytes come back 304", async () => {
    const page = await (await get("/alice/vault", owner)).text();
    expect(page).toContain('id="live-now"');
    expect(page).toContain('data-live-src="/alice/vault/app/now"');

    const first = await get("/alice/vault/app/now", owner);
    expect(first.status).toBe(200);
    expect(first.headers.get("x-content-type-options")).toBe("nosniff");
    expect(first.headers.get("cache-control")).toBe("no-store");
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);
    const text = await first.text();
    // The tag rides in the markup as well, for a proxy that drops the header.
    expect(text).toMatch(/^\s*<div data-etag="[0-9a-f]{16}"/);
    expect(`"${/data-etag="([0-9a-f]{16})"/.exec(text)![1]}"`).toBe(etag!);
    expect(text).toContain('id="live-now"');
    expect(text).toContain('data-live="run.*,pull.*,issue.*"');
    expect(text).toContain('data-live-src="/alice/vault/app/now"');
    expect(text).toContain("<h2>Now</h2>");

    // The same bytes again: nothing to paint, and nothing sent to paint.
    const again = await fetch(`${base}/alice/vault/app/now`, {
      headers: {
        cookie: `${owner}; forge_mode=studio`,
        "if-none-match": etag!,
      },
    });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(etag);
    expect(await again.text()).toBe("");

    // A stale tag is answered in full.
    const stale = await fetch(`${base}/alice/vault/app/now`, {
      headers: { cookie: `${owner}; forge_mode=studio`, "if-none-match": '"0"' },
    });
    expect(stale.status).toBe(200);
    expect(await stale.text()).toContain("<h2>Now</h2>");

    expect((await get("/alice/vault/app/now", stranger)).status).toBe(404);
    expect((await fetch(`${base}/alice/vault/app/now`)).status).toBe(404);
  });

  test("a preview flips from deploying to live between two calls, and the link stays correct", async () => {
    const alice = getUserByName(app.db, "alice")!;
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/x",
      base: repo.defaultBranch,
      message: "Add X",
      files: [{ path: "X.md", content: "x\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "Add X",
      body: "",
      baseBranch: repo.defaultBranch,
      headBranch: "feature/x",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    const env = previewEnv(pull.number);
    const link = `href="/alice/vault/app/${env}/open"`;

    const deployRun = createRun(app.db, {
      repoId: repo.id,
      kind: "deploy",
      env,
      commitOid: pull.headOid,
      reason: "pull",
    });
    claimRun(app.db, deployRun.id);
    putEnv(env, {
      deploying: {
        run: { id: deployRun.id, commitOid: pull.headOid },
        abort: new AbortController(),
      },
    });
    const starting = await (await get("/alice/vault/app/state", owner)).text();
    expect(starting).toContain("starting");
    expect(starting).not.toContain(">live<");
    expect(starting).toContain(link);

    finishRun(app.db, deployRun.id, { state: "ok", summary: "deploy" });
    putEnv(env, {
      live: {
        commitOid: pull.headOid,
        handle: { port: 4321 },
        runId: deployRun.id,
        since: new Date().toISOString(),
        manifest: { tty: null },
      },
    });
    const live = await (await get("/alice/vault/app/state", owner)).text();
    expect(live).not.toContain("starting");
    expect(live).toContain(">live<");
    expect(live).toContain(link);
  });

  test("the fragment's markup is what the live client's status announcement reads: the head's word in a badge, a preview row's word beside its `#N title`", async () => {
    // `live.ts`'s `announceSwap` finds the head's word at `.studio-head
    // .badge` and, for a preview row, the pull's label at the start of
    // `.row-meta` beside its word at `.row-trail .badge`. If this markup
    // ever moves, the announcement goes silent without a test failing here.
    const text = await (await get("/alice/vault/app/state", owner)).text();
    expect(text).toContain("studio-head");
    expect(text).toMatch(/studio-head[\s\S]*?class="badge"[^>]*>not running</);

    const alice = getUserByName(app.db, "alice")!;
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/announce",
      base: repo.defaultBranch,
      message: "Add Y",
      files: [{ path: "Y.md", content: "y\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "Add Y",
      body: "",
      baseBranch: repo.defaultBranch,
      headBranch: "feature/announce",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    const env = previewEnv(pull.number);
    const deployRun = createRun(app.db, {
      repoId: repo.id,
      kind: "deploy",
      env,
      commitOid: pull.headOid,
      reason: "pull",
    });
    claimRun(app.db, deployRun.id);
    finishRun(app.db, deployRun.id, { state: "ok", summary: "deploy" });
    putEnv(env, {
      live: {
        commitOid: pull.headOid,
        handle: { port: 4323 },
        runId: deployRun.id,
        since: new Date().toISOString(),
        manifest: { tty: null },
      },
    });
    const withPreview = await (
      await get("/alice/vault/app/state", owner)
    ).text();
    const label = `#${pull.number} Add Y`;
    expect(withPreview).toContain(`class="row-meta"`);
    expect(withPreview).toContain(`class="row-trail"`);
    expect(withPreview).toContain(label);
    expect(
      new RegExp(`${label}[\\s\\S]*?class="row-trail"[\\s\\S]*?>live<`).test(
        withPreview,
      ),
    ).toBe(true);
  });

  test("the head measures from the push, not from the permit it waited for: a deploy queued 5s reads 6.0s after the push and names the wait", async () => {
    const createdAt = new Date(Date.now() - 20_000).toISOString();
    const deployStartedAt = new Date(
      Date.parse(createdAt) + 5_000,
    ).toISOString();
    const servingAt = new Date(
      Date.parse(deployStartedAt) + 1_000,
    ).toISOString();
    const deployRun = createRun(app.db, {
      repoId: repo.id,
      kind: "deploy",
      env: "production",
      commitOid: "cafebabe",
      reason: "push",
    });
    claimRun(app.db, deployRun.id);
    finishRun(app.db, deployRun.id, { state: "ok", summary: "deploy" });
    putEnv("production", {
      live: {
        commitOid: "cafebabe",
        handle: { port: 4322 },
        runId: deployRun.id,
        since: servingAt,
        servingAt,
        createdAt,
        deployStartedAt,
        manifest: { tty: null },
      },
    });

    const head = await (await get("/alice/vault/app/state", owner)).text();
    expect(head).toContain("live 6.0s after the push · 5.0s queued");
    expect(head).not.toContain("1.0s after the push");

    // The same deployment with no wait for a permit says only the one
    // number, exactly as it always has.
    putEnv("production", {
      live: {
        commitOid: "cafebabe",
        handle: { port: 4322 },
        runId: deployRun.id,
        since: servingAt,
        servingAt,
        createdAt: deployStartedAt,
        deployStartedAt,
        manifest: { tty: null },
      },
    });
    const prompt = await (await get("/alice/vault/app/state", owner)).text();
    expect(prompt).toContain("live 1.0s after the push");
    expect(prompt).not.toContain("queued");

    // A deploy no push asked for — a redeploy someone pressed — carries no
    // push instant, and its words never claim one.
    putEnv("production", {
      live: {
        commitOid: "cafebabe",
        handle: { port: 4322 },
        runId: deployRun.id,
        since: servingAt,
        servingAt,
        deployStartedAt,
        manifest: { tty: null },
      },
    });
    const pressed = await (await get("/alice/vault/app/state", owner)).text();
    expect(pressed).toContain("live 1.0s after the deploy started");
    expect(pressed).not.toContain("after the push");
  });

  test("app.serving reaches the repo's stream with the shape the live client keys on, the instant the swap-in happens — before its run has finished", async () => {
    const deployRun = createRun(app.db, {
      repoId: repo.id,
      kind: "deploy",
      env: "production",
      commitOid: "deadbeef",
      reason: "push",
    });
    claimRun(app.db, deployRun.id);
    const served = markServing(app.db, deployRun.id);
    expect(served?.servingAt).toBeDefined();

    const stream = await fetch(`${base}/alice/vault/stream`, {
      headers: { cookie: owner },
    });
    await Bun.sleep(50);

    // The exact append `AppsRuntime` makes at the swap-in (runtime.ts),
    // republished here so the test does not have to spin up a real deploy.
    app.bus.append({
      kind: "app.serving",
      repoId: repo.id,
      payload: {
        app: record.slug,
        env: "production",
        commitOid: deployRun.commitOid,
        servingAt: served!.servingAt,
        testsRunning: true,
      },
    });

    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let event: Record<string, unknown> | undefined;
    const deadline = Date.now() + 5_000;
    while (!event && Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value);
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        if (!/^event: app\.serving$/m.test(frame)) continue;
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (data !== undefined) event = JSON.parse(data);
      }
    }
    await reader.cancel().catch(() => {});
    expect(event).toBeDefined();
    expect(event?.["kind"]).toBe("app.serving");
    const payload = event?.["payload"] as Record<string, unknown>;
    expect(payload["app"]).toBe(record.slug);
    expect(payload["env"]).toBe("production");
    expect(payload["commitOid"]).toBe(deployRun.commitOid);
    expect(payload["servingAt"]).toBe(served!.servingAt);
    expect(payload["testsRunning"]).toBe(true);

    // finishRun never ran: run.finished has not fired, yet app.serving
    // already has. That gap is the whole point of the issue.
    expect(getRun(app.db, deployRun.id)?.state).toBe("running");
  });

  test("production's Open the app link appears only once it is serving, and the fragment after a swap flips it", async () => {
    const link = 'href="/alice/vault/app/production/open"';
    const deployRun = createRun(app.db, {
      repoId: repo.id,
      kind: "deploy",
      env: "production",
      commitOid: "cafed00d",
      reason: "push",
    });
    claimRun(app.db, deployRun.id);
    putEnv("production", {
      deploying: {
        run: { id: deployRun.id, commitOid: "cafed00d" },
        abort: new AbortController(),
      },
    });
    const deploying = await (await get("/alice/vault/app/state", owner)).text();
    expect(deploying).toContain("starting");
    expect(deploying).not.toContain(link);

    finishRun(app.db, deployRun.id, { state: "ok", summary: "deploy" });
    putEnv("production", {
      live: {
        commitOid: "cafed00d",
        handle: { port: 4325 },
        runId: deployRun.id,
        since: new Date().toISOString(),
        manifest: { tty: null },
      },
    });
    const serving = await (await get("/alice/vault/app/state", owner)).text();
    expect(serving).toContain(">live<");
    expect(serving).toContain(link);
  });
  test("a preview row says how fast it got there in envFacts' own words, links its deploy run, and keeps its link and sentence while deploying or after its tests failed", async () => {
    const alice = getUserByName(app.db, "alice")!;
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/fast",
      base: repo.defaultBranch,
      message: "Add F",
      files: [{ path: "F.md", content: "f\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "Add F",
      body: "",
      baseBranch: repo.defaultBranch,
      headBranch: "feature/fast",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    const env = previewEnv(pull.number);
    const open = `href="/alice/vault/app/${env}/open"`;
    const label = `#${pull.number} Add F`;
    const deployRun = createRun(app.db, {
      repoId: repo.id,
      kind: "deploy",
      env,
      commitOid: pull.headOid,
      reason: "pull",
    });
    const runLink = `href="/alice/vault/runs/${deployRun.id}"`;
    // This pull's own row out of the previews panel, so nothing the head
    // card or another pull's row says can pass for it.
    const rowOf = (text: string): string => {
      const panel = text.slice(text.indexOf('id="app-previews"'));
      const at = panel.indexOf(label);
      expect(at).toBeGreaterThan(-1);
      return panel.slice(panel.lastIndexOf("<li>", at), panel.indexOf("</li>", at));
    };

    claimRun(app.db, deployRun.id);
    putEnv(env, {
      deploying: {
        run: { id: deployRun.id, commitOid: pull.headOid },
        abort: new AbortController(),
      },
    });
    const deploying = rowOf(
      await (await get("/alice/vault/app/state", owner)).text(),
    );
    expect(deploying).toContain(open);
    expect(deploying).toContain(runLink);
    expect(deploying).toContain("deploy in progress");
    expect(deploying).not.toContain("after the push");
    expect(deploying).not.toContain("0.0s");

    finishRun(app.db, deployRun.id, { state: "ok", summary: "deploy" });
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    const servingAt = new Date(Date.parse(createdAt) + 3_400).toISOString();
    putEnv(env, {
      live: {
        commitOid: pull.headOid,
        handle: { port: 4324 },
        runId: deployRun.id,
        since: servingAt,
        servingAt,
        createdAt,
        deployStartedAt: createdAt,
        manifest: { tty: null },
      },
    });
    const live = rowOf(await (await get("/alice/vault/app/state", owner)).text());
    expect(live).toContain(open);
    expect(live).toContain("live 3.4s after the push");
    expect(live).toContain(pull.headOid.slice(0, 7));
    expect(live).toContain(runLink);
    expect(live).toContain(">live<");
    // The live client keys its announcement on the meta line's first words.
    expect(live).toMatch(new RegExp(`class="row-meta">#${pull.number} Add F ·`));
    // The page's first paint draws the same row.
    expect(await (await get("/alice/vault", owner)).text()).toContain(
      "live 3.4s after the push",
    );

    putEnv(env, {
      live: {
        commitOid: pull.headOid,
        handle: { port: 4324 },
        runId: deployRun.id,
        since: servingAt,
        servingAt,
        createdAt,
        deployStartedAt: createdAt,
        testsFailed: "2 failing",
        manifest: { tty: null },
      },
    });
    const red = rowOf(await (await get("/alice/vault/app/state", owner)).text());
    expect(red).toContain(open);
    expect(red).toContain(runLink);
    expect(red).toContain("serving · tests failed: 2 failing");
    expect(red).toContain("live 3.4s after the push");
    // One badge, not green, and the row still links to the preview.
    expect(red).toMatch(/data-variant="attn"[^]*?serving · tests failed<\/span/);
    expect(red).not.toContain('data-variant="success"');
    expect(red).not.toContain(">live<");

    putEnv(env, {
      deploying: {
        run: { id: deployRun.id, commitOid: pull.headOid },
        abort: new AbortController(),
      },
      live: {
        commitOid: pull.headOid,
        handle: { port: 4324 },
        runId: deployRun.id,
        since: servingAt,
        servingAt,
        createdAt,
        deployStartedAt: createdAt,
        manifest: { tty: null },
      },
    });
    const verifying = rowOf(
      await (await get("/alice/vault/app/state", owner)).text(),
    );
    expect(verifying).toContain(open);
    expect(verifying).toContain("serving · verifying</span");
    expect(verifying).not.toContain('data-variant="success"');
    expect(verifying).not.toContain('data-variant="attn"');

    putEnv(env, {
      live: {
        commitOid: pull.headOid,
        handle: { port: 4324 },
        runId: deployRun.id,
        since: servingAt,
        manifest: { tty: null },
      },
    });
    const unmeasured = rowOf(
      await (await get("/alice/vault/app/state", owner)).text(),
    );
    expect(unmeasured).toContain(open);
    expect(unmeasured).not.toContain("after the");
    expect(unmeasured).not.toContain("0.0s");
  });
});

/**
 * On its own: the slots line counts what the loop counts — the builders —
 * while Now still shows every run in flight, review and plan included.
 */
describe("the studio's slot count", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let cookie: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-studio-slots-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, { trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    const alice = a.value;
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
      name: "loom",
      visibility: "private",
      description: "a place for cloth",
    });
    if (!made.ok) throw new Error(String(made.error));
    const repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# loom\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, alice, repo, { slug: "loom" });
    if (!enabled.ok) throw new Error(String(enabled.error));
    for (const name of ["brick", "quill", "chart"]) {
      const agent = await createAgent(app, alice, { username: name });
      if (!agent.ok) throw new Error(String(agent.error));
      expect(addToCrew(app, alice, repo, name).ok).toBe(true);
    }
    const reviewer = getUserByName(app.db, "quill")!;
    const planner = getUserByName(app.db, "chart")!;
    setCrewRole(app.db, repo.id, reviewer.id, "reviewer");
    setCrewRole(app.db, repo.id, planner.id, "planner");
    const on = await updateRepoSettings(app, alice, repo, {
      autonomy: "autonomous",
      autonomyDirection: "",
      autonomyCeilingUsd: 10,
      autonomySlots: 2,
      autonomyBy: alice.id,
    });
    expect(on.ok).toBe(true);
    // One builder building, one reviewer reviewing, one planner planning.
    const inFlight: [string, User, string][] = [
      ["Warp the loom", getUserByName(app.db, "brick")!, "assigned"],
      ["Look at the shuttle", reviewer, "review"],
      ["Plan the next cloth", planner, "assigned"],
    ];
    for (const [title, actor, reason] of inFlight) {
      const issue = openIssue(app, alice, repo, { title });
      if (!issue.ok) throw new Error(String(issue.error));
      const run = createRun(app.db, {
        repoId: repo.id,
        kind: "agent",
        issueId: issue.value.id,
        actorId: actor.id,
        reason,
      });
      claimRun(app.db, run.id);
    }
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("reads 1 of 2 in use with three runs in flight, and Now still lists all three", async () => {
    const page = await (
      await fetch(`${base}/alice/loom`, {
        headers: { cookie: `${cookie}; forge_mode=studio` },
        redirect: "manual",
      })
    ).text();
    expect(page).toContain("1 of 2 in use");
    expect(page).not.toContain("3 of 2");
    expect(page).not.toContain("2 of 2");
    // The runs that take no slot are not hidden: Now has all of them.
    expect(page).toContain("Warp the loom");
    expect(page).toContain("Look at the shuttle");
    expect(page).toContain("Plan the next cloth");
  });
});

describe("words come from facts, not from run.summary", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let repo: Repo;
  let record: AppRecord;
  let alice: User;
  let wordCtx: WordCtx;
  let seededCommit: string;

  const put = (live?: { commitOid: string; state?: "failed" }): void => {
    const envs = (runtime as unknown as { envs: Map<string, unknown> }).envs;
    envs.set(`${record.id}/production`, {
      app: record,
      env: "production",
      chain: Promise.resolve(),
      restarts: [],
      ...(live?.state === "failed"
        ? { lastError: "the deploy failed" }
        : live
          ? {
              live: {
                commitOid: live.commitOid,
                handle: { port: 4321 },
                runId: "fake",
                since: new Date().toISOString(),
                manifest: { tty: null },
              },
            }
          : {}),
    });
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-studio-words-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    runtime = new AppsRuntime(app, {
      domain: "words.test",
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 1,
    });
    const a = await createUser(app.db, { trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createRepo(app, alice, {
      name: "wordsapp",
      visibility: "private",
      description: "",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "start\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    seededCommit = seeded.value.commitOid;
    const enabled = await enableApp(app, alice, repo, { slug: "wordsapp" });
    if (!enabled.ok) throw new Error(String(enabled.error));
    record = getAppByRepo(app.db, repo.id)!;
    wordCtx = {
      db: app.db,
      dir: repoDir(app.reposRoot, repo.ownerName, repo.name),
      runtime,
      record,
      history: servingHistory(),
    };
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a merged pull whose production deploy has not yet served does not say shipped, and says so once it has", async () => {
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/word",
      base: "main",
      message: "Add a word",
      files: [{ path: "WORD.md", content: "word\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "Add a word",
      body: "",
      baseBranch: "main",
      headBranch: "feature/word",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const merged = await mergePull(app, alice, repo, opened.value, "squash");
    if (!merged.ok) throw new Error(String(merged.error));
    const pull = getPull(app.db, repo.id, opened.value.number)!;
    expect(pull.mergedOid).not.toBeNull();

    // Production is still on the commit before the merge: not shipped.
    put({ commitOid: seededCommit });
    const notYet = await pullWord(wordCtx, pull);
    expect(notYet.word).not.toBe("shipped");

    // Production has caught up to the merge commit: shipped, live.
    put({ commitOid: pull.mergedOid! });
    const now = await pullWord(wordCtx, pull);
    expect(now.word).toBe("shipped");
  });

  test("a page of merged pulls asks git about production once, however many rows (#285)", async () => {
    const pulls: Pull[] = [];
    for (let i = 0; i < 5; i++) {
      const branch = await commitToBranch(app, alice, repo, {
        branch: `feature/many-${i}`,
        base: "main",
        message: `Many ${i}`,
        files: [{ path: `MANY-${i}.md`, content: `${i}\n` }],
      });
      if (!branch.ok) throw new Error(JSON.stringify(branch.error));
      const opened = await openPull(app, alice, repo, {
        title: `Many ${i}`,
        body: "",
        baseBranch: "main",
        headBranch: `feature/many-${i}`,
      });
      if (!opened.ok) throw new Error(String(opened.error));
      const merged = await mergePull(app, alice, repo, opened.value, "squash");
      if (!merged.ok) throw new Error(String(merged.error));
      pulls.push(getPull(app.db, repo.id, opened.value.number)!);
    }

    // Every git process spawned while one page's words are decided.
    const spawned: string[] = [];
    const original = Bun.spawn.bind(Bun);
    const spy = spyOn(Bun, "spawn").mockImplementation(((
      cmd: string[],
      options: never,
    ) => {
      if (cmd[0] === "git") spawned.push(cmd.slice(1).join(" "));
      return original(cmd, options);
    }) as unknown as typeof Bun.spawn);
    const wordsOfOnePage = async (): Promise<string[]> => {
      const page: WordCtx = { ...wordCtx, history: servingHistory() };
      const words = await Promise.all(pulls.map((p) => pullWord(page, p)));
      return words.map((w) => w.word);
    };
    try {
      // Production at the second merge: that one and the one before it are
      // shipped (ancestry, not equality), the three after it are not.
      put({ commitOid: pulls[1]!.mergedOid! });
      expect(await wordsOfOnePage()).toEqual([
        "shipped",
        "shipped",
        "waiting",
        "waiting",
        "waiting",
      ]);
      expect(spawned).toHaveLength(1);

      // A new page is a new question: the deploy that just landed is seen.
      spawned.length = 0;
      put({ commitOid: pulls[4]!.mergedOid! });
      expect(new Set(await wordsOfOnePage())).toEqual(new Set(["shipped"]));
      expect(spawned).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  test("an agent run that opened no pull and pushed nothing is not shipped", async () => {
    const told = await openIssue(app, alice, repo, {
      title: "Write a plan",
      body: "",
    });
    if (!told.ok) throw new Error(String(told.error));
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: told.value.id,
      branch: "scout/999-a-branch-nothing-used",
      actorId: alice.id,
      reason: "assigned",
    });
    claimRun(app.db, run.id);
    const finished = finishRun(app.db, run.id, {
      state: "ok",
      summary: "wrote docs/PLAN.md",
    });
    const word = await runWord(wordCtx, finished!);
    expect(word.word).not.toBe("shipped");
    expect(word.word).toBe("planned");
    expect(word.note).toBe("wrote docs/PLAN.md");
  });

  test("a deploy serving with failed tests is not shipped", async () => {
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/preview",
      base: "main",
      message: "Preview",
      files: [{ path: "PREVIEW.md", content: "preview\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "Preview",
      body: "",
      baseBranch: "main",
      headBranch: "feature/preview",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    const deploy = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: pull.id,
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
      reason: "pull",
    });
    claimRun(app.db, deploy.id);
    markServing(app.db, deploy.id);
    finishRun(app.db, deploy.id, {
      state: "failed",
      summary: "test: 1 of 3 tests failed",
    });
    const word = await pullWord(
      wordCtx,
      getPull(app.db, repo.id, pull.number)!,
    );
    expect(word.word).not.toBe("shipped");
    expect(word.note).toBe("serving, but the check failed");
  });
});

/**
 * Working, on its own page: `/:owner/:name/runs/:id` in the studio names
 * the tell, the cost, and offers the steer box — same routes and checks as
 * dev's transcript, one click away at `?mode=dev`.
 */
describe("working: a run's own page in the studio", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let repo: Repo;
  let alice: User;
  let scoutId: string;
  let writerCookie: string;
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

  const get = (path: string, cookie: string) =>
    fetch(`${base}${path}`, {
      headers: { cookie: `${cookie}; forge_mode=studio` },
      redirect: "manual",
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-studio-run-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, { trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const b = await createUser(app.db, { trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    writerCookie = await signIn("alice");
    readerCookie = await signIn("bob");
    const made = await createRepo(app, a.value, {
      name: "engine",
      visibility: "private",
      description: "an app that builds",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, a.value, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "engine\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, a.value, repo, { slug: "engine" });
    if (!enabled.ok) throw new Error(String(enabled.error));
    const scout = await createAgent(app, a.value, { username: "scout" });
    if (!scout.ok) throw new Error(String(scout.error));
    scoutId = scout.value.user.id;
    expect(addToCrew(app, a.value, repo, "scout").ok).toBe(true);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the studio transcript names the tell, the cost, and the steer box", async () => {
    const tell = openIssue(app, alice, repo, {
      title: "Fix the flicker on load",
      body: "It flashes white before the page renders.",
    });
    if (!tell.ok) throw new Error(String(tell.error));
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: tell.value.id,
      actorId: scoutId,
      reason: "assigned",
    });
    claimRun(app.db, run.id);
    noteRunProgress(app.db, run.id, { costUsd: 0.42 });

    const page = await (
      await get(`/alice/engine/runs/${run.id}`, writerCookie)
    ).text();
    expect(page).toContain("Fix the flicker on load");
    // The tell it came from, in the studio's own noun (#158).
    expect(page).toContain(`href="/alice/engine/tells/${tell.value.number}"`);
    expect(page).toContain("$0.42 spent");
    expect(page).toContain('data-word="working"');
    // An agent's own run still speaks in the agent's name (#195).
    expect(page).toContain('data-who="scout"');
    expect(page).toContain('id="run-steer"');
    expect(page).toContain("Steer scout");
    expect(page).toContain('id="run-stop"');
    // The transcript is on the page, and there is no second reading of it.
    expect(page).toContain('id="run-log"');
    expect(page).not.toContain("?mode=dev");
  });

  test("a long transcript holds its last window, and the whole of it is one step deeper at ?all=1", async () => {
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      actorId: scoutId,
      reason: "assigned",
    });
    claimRun(app.db, run.id);
    for (let n = 0; n < 450; n++)
      appendRunLog(app.config.dataDir, run.id, `line number ${n}`);
    finishRun(app.db, run.id, { state: "ok", summary: "done" });

    const page = await (
      await get(`/alice/engine/runs/${run.id}`, writerCookie)
    ).text();
    expect(page).not.toContain("line number 0<");
    expect(page).toContain("line number 449");
    expect(page).toContain(`href="/alice/engine/runs/${run.id}?all=1"`);

    const all = await (
      await get(`/alice/engine/runs/${run.id}?all=1`, writerCookie)
    ).text();
    expect(all).toContain("line number 0<");
    expect(all).toContain("line number 449");

    // The depth step is refused exactly as the run is.
    const anon = await fetch(`${base}/alice/engine/runs/${run.id}?all=1`, {
      redirect: "manual",
    });
    expect(anon.status).toBe(404);
  });

  test("a reader without access gets the forge's not-found, exactly as dev", async () => {
    const tell = openIssue(app, alice, repo, { title: "Private work" });
    if (!tell.ok) throw new Error(String(tell.error));
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: tell.value.id,
      actorId: scoutId,
      reason: "assigned",
    });
    claimRun(app.db, run.id);

    const asReader = await get(`/alice/engine/runs/${run.id}`, readerCookie);
    expect(asReader.status).toBe(404);
  });

  test("a finished run renders in the studio's own word, with no Stop", async () => {
    const tell = openIssue(app, alice, repo, { title: "Tidy the footer" });
    if (!tell.ok) throw new Error(String(tell.error));
    const branch = await commitToBranch(app, alice, repo, {
      branch: "scout/tidy-the-footer",
      base: "main",
      message: "Tidy the footer",
      files: [{ path: "FOOTER.md", content: "tidy\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "Tidy the footer",
      body: `Closes #${tell.value.number}`,
      baseBranch: "main",
      headBranch: "scout/tidy-the-footer",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    // The word comes from the pull this run actually produced (found by
    // its branch), not from parsing the summary below.
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: tell.value.id,
      branch: "scout/tidy-the-footer",
      actorId: scoutId,
      reason: "assigned",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, {
      state: "ok",
      summary: `opened pull #${opened.value.number}`,
      costUsd: 0.1,
      turns: 4,
    });

    const page = await (
      await get(`/alice/engine/runs/${run.id}`, writerCookie)
    ).text();
    // The badge itself, not a stylesheet that happens to mention the word:
    // this read `data-word="look"` until the studio's rules moved out of the
    // page, and matched `.studio-list li[data-word="look"]` in the inline
    // <style>, never the badge. The pull has no deploy of this head, so its
    // word is `waiting` — and the point stands either way: the word came
    // from the pull found by branch, not from the summary (`planned` is what
    // a run with nothing to show would say).
    expect(page).toMatch(/data-word="waiting"\s+id="run-word"/);
    expect(page).not.toContain('data-word="planned"');
    expect(page).not.toContain('id="run-stop"');
    expect(page).not.toContain(">Stop<");
    expect(page).not.toContain(">Cancel run<");
  });

  test("a deploy's own run page speaks as the deploy, reads as done rather than planned, and prints a tenth for a sub-second run (#195)", async () => {
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "deploy",
      env: "production",
      commitOid: "c740479",
      reason: "boot",
    });
    claimRun(app.db, run.id);
    appendRunLog(app.config.dataDir, run.id, "$ bun test");
    appendRunLog(app.config.dataDir, run.id, "bun test v1.3.14 (0d9b296a)");
    appendRunLog(
      app.config.dataDir,
      run.id,
      "(pass) the page knows who you are and offers the right door [3.61ms]",
    );
    finishRun(app.db, run.id, { state: "ok", summary: "deploy" });
    // A run that took 300ms — today's whole-second rounding reads "took 0s".
    app.db
      .query("UPDATE run SET started_at = ?2, finished_at = ?3 WHERE id = ?1")
      .run(run.id, "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.300Z");

    const page = await (
      await get(`/alice/engine/runs/${run.id}`, writerCookie)
    ).text();
    // The deploy speaks for itself: the box, and every line in it — never
    // "an agent", which is nobody that was actually there.
    expect(page).toContain('data-who="the deploy"');
    expect(page).toContain('class="who">the deploy<');
    expect(page).not.toContain("an agent");
    // A deploy that finished with nothing else to show reads as done, not
    // as a run that has not started yet.
    expect(page).toContain('data-word="done"');
    expect(page).not.toContain('data-word="planned"');
    // Sub-second, in tenths — not rounded away to "took 0s".
    expect(page).toContain(">took 0.3s<");
  });
});

/**
 * Issue #88: the app's page tails the crew's log while it works — the last
 * handful of lines beside the running row, live, bounded, and with a
 * no-script fallback that behaves like the run page's own. Its own repo and
 * app, so no other test's still-running run ever counts as "the active run"
 * here.
 */
describe("the app's page tails the crew's log while it works", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let repo: Repo;
  let alice: User;
  let scoutId: string;
  let writerCookie: string;
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

  const get = (path: string, cookie: string) =>
    fetch(`${base}${path}`, {
      headers: { cookie: `${cookie}; forge_mode=studio` },
      redirect: "manual",
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-studio-tail-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, { trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const b = await createUser(app.db, { trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    writerCookie = await signIn("alice");
    readerCookie = await signIn("bob");
    const made = await createRepo(app, a.value, {
      name: "engine",
      visibility: "private",
      description: "an app that builds",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, a.value, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "engine\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, a.value, repo, { slug: "engine" });
    if (!enabled.ok) throw new Error(String(enabled.error));
    const scout = await createAgent(app, a.value, { username: "scout" });
    if (!scout.ok) throw new Error(String(scout.error));
    scoutId = scout.value.user.id;
    expect(addToCrew(app, a.value, repo, "scout").ok).toBe(true);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the app's page carries the tail of the active run's log, bounded, and refreshes without a script", async () => {
    const tell = openIssue(app, alice, repo, { title: "Speed up boot" });
    if (!tell.ok) throw new Error(String(tell.error));
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: tell.value.id,
      actorId: scoutId,
      reason: "assigned",
    });
    claimRun(app.db, run.id);
    for (let i = 0; i < 9; i++)
      appendRunLog(app.config.dataDir, run.id, `line ${i}`);

    const page = await (await get("/alice/engine", writerCookie)).text();
    expect(page).toContain('id="app-run-tail"');
    expect(page).toContain(
      `data-stream="/api/v1/repos/alice/engine/runs/${run.id}/log?follow=1"`,
    );
    // Bounded on the first paint too: only the last handful made it, and
    // the box says so.
    expect(page).not.toContain(">line 0<");
    expect(page).toContain(">line 8<");
    expect(page).toContain("Holding the last 6 lines here");
    // No script, no problem: the page keeps refreshing while the run goes.
    expect(page).toContain('http-equiv="refresh"');

    const stream = await get(
      `/api/v1/repos/alice/engine/runs/${run.id}/log?follow=1`,
      writerCookie,
    );
    expect(stream.status).toBe(200);

    finishRun(app.db, run.id, { state: "ok", summary: "planned" });
    const settled = await (await get("/alice/engine", writerCookie)).text();
    expect(settled).not.toContain('id="app-run-tail"');
  });

  test("a log far larger than the tail's cap still ends the page at its true last line", async () => {
    const tell = openIssue(app, alice, repo, { title: "Long-running build" });
    if (!tell.ok) throw new Error(String(tell.error));
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: tell.value.id,
      actorId: scoutId,
      reason: "assigned",
    });
    claimRun(app.db, run.id);
    // Far past a byte cap sized for a handful of lines (old default: 512KB).
    for (let i = 0; i < 2000; i++)
      appendRunLog(app.config.dataDir, run.id, `line ${i}`);

    const page = await (await get("/alice/engine", writerCookie)).text();
    expect(page).not.toContain(">line 1993<");
    expect(page).toContain(">line 1999<");
    expect(page).toContain("Holding the last 6 lines here");

    finishRun(app.db, run.id, { state: "ok", summary: "planned" });
  });

  test("a reader without access gets the forge's not-found from the page and from the tail's own stream", async () => {
    const tell = openIssue(app, alice, repo, { title: "Private boot work" });
    if (!tell.ok) throw new Error(String(tell.error));
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: tell.value.id,
      actorId: scoutId,
      reason: "assigned",
    });
    claimRun(app.db, run.id);
    appendRunLog(app.config.dataDir, run.id, "line 0");

    const page = await get("/alice/engine", readerCookie);
    expect(page.status).toBe(404);
    const stream = await get(
      `/api/v1/repos/alice/engine/runs/${run.id}/log?follow=1`,
      readerCookie,
    );
    expect(stream.status).toBe(404);
    finishRun(app.db, run.id, { state: "ok", summary: "planned" });
  });
});

/**
 * Issue #145: the run a brand-new app is waiting on is its first deploy, not
 * an agent's — the head card tails production's own deploy the same way a
 * running row is tailed, and yields to an agent run's own tail when one is
 * also going, so the page never opens two streams for one repo.
 */
describe("the app's page tails the deploy that is bringing it alive", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let runtime: AppsRuntime;
  let repo: Repo;
  let record: AppRecord;
  let owner: string;
  let scoutId: string;

  interface PreviewSlot {
    readonly app: AppRecord;
    readonly env: EnvName;
    readonly chain: Promise<void>;
    readonly restarts: number[];
    deploying?: unknown;
    live?: unknown;
    lastError?: string;
    lastRunId?: string;
  }
  const putEnv = (
    env: EnvName,
    slot: Omit<PreviewSlot, "app" | "env" | "chain" | "restarts">,
  ): void => {
    (runtime as unknown as { envs: Map<string, PreviewSlot> }).envs.set(
      `${record.id}/${env}`,
      { app: record, env, chain: Promise.resolve(), restarts: [], ...slot },
    );
  };

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

  const get = (path: string, cookie: string) =>
    fetch(`${base}${path}`, {
      headers: { cookie: `${cookie}; forge_mode=studio` },
      redirect: "manual",
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-studio-deploy-tail-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    runtime = new AppsRuntime(app, {
      domain: "deploytail.test",
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 1,
    });
    const a = await createUser(app.db, { trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    owner = await signIn("alice");
    const made = await createRepo(app, a.value, {
      name: "kindling",
      visibility: "private",
      description: "a new app",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, a.value, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "kindling\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, a.value, repo, { slug: "kindling" });
    if (!enabled.ok) throw new Error(String(enabled.error));
    record = getAppByRepo(app.db, repo.id)!;
    const scout = await createAgent(app, a.value, { username: "scout" });
    if (!scout.ok) throw new Error(String(scout.error));
    scoutId = scout.value.user.id;
    expect(addToCrew(app, a.value, repo, "scout").ok).toBe(true);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a production deploy under way, with no agent run going, is tailed in the head card and named as the deploy's own stream", async () => {
    const deployRun = createRun(app.db, {
      repoId: repo.id,
      kind: "deploy",
      env: "production",
      commitOid: "f00dcafe",
      reason: "boot",
    });
    claimRun(app.db, deployRun.id);
    appendRunLog(app.config.dataDir, deployRun.id, "checking out f00dcafe");
    appendRunLog(app.config.dataDir, deployRun.id, "install …");
    putEnv("production", {
      deploying: {
        run: { id: deployRun.id, commitOid: "f00dcafe" },
        abort: new AbortController(),
      },
    });

    const page = await (await get("/alice/kindling", owner)).text();
    expect(page).toContain('id="app-run-tail"');
    expect(page).toContain('data-who="the deploy"');
    expect(page).toContain(
      `data-stream="/api/v1/repos/alice/kindling/runs/${deployRun.id}/log?follow=1"`,
    );
    expect(page).toContain("install …");
    // No script, no problem: the page keeps refreshing while the deploy
    // goes — the actual meta tag, not just the script's own selector text.
    expect(page).toMatch(/<meta\s+http-equiv="refresh"/);
    // Issue #163: the deploy is plainly going, in the head card above — "Now"
    // does not also claim nothing is happening, and it does not open a
    // second stream of the same lines to say so.
    expect(page).not.toContain("Nothing yet");
    expect(page).toContain("Production is coming up");
    expect(page.match(/id="app-run-tail"/g)?.length).toBe(1);

    finishRun(app.db, deployRun.id, { state: "ok", summary: "deploy" });
  });

  test("an agent run at work outranks a background deploy: the page follows the crew, never both", async () => {
    const deployRun = createRun(app.db, {
      repoId: repo.id,
      kind: "deploy",
      env: "production",
      commitOid: "d0d0d0d0",
      reason: "push",
    });
    claimRun(app.db, deployRun.id);
    appendRunLog(app.config.dataDir, deployRun.id, "deploying d0d0d0d0");
    putEnv("production", {
      deploying: {
        run: { id: deployRun.id, commitOid: "d0d0d0d0" },
        abort: new AbortController(),
      },
    });

    const tell = openIssue(app, getUserByName(app.db, "alice")!, repo, {
      title: "Add a footer",
    });
    if (!tell.ok) throw new Error(String(tell.error));
    const agentRun = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: tell.value.id,
      actorId: scoutId,
      reason: "assigned",
    });
    claimRun(app.db, agentRun.id);
    appendRunLog(app.config.dataDir, agentRun.id, "scout is on it");

    const page = await (await get("/alice/kindling", owner)).text();
    // Exactly one tail, and it is the crew's own run — never the deploy's.
    expect(page.match(/id="app-run-tail"/g)?.length).toBe(1);
    expect(page).not.toContain('data-who="the deploy"');
    expect(page).toContain(
      `data-stream="/api/v1/repos/alice/kindling/runs/${agentRun.id}/log?follow=1"`,
    );

    finishRun(app.db, deployRun.id, { state: "ok", summary: "deploy" });
    finishRun(app.db, agentRun.id, { state: "ok", summary: "planned" });
  });

  // Issue #284: production stays "live" long after its deploy finishes, and
  // a fresh live process that has written nothing to its log yet is not an
  // empty black box — the card says so in a line instead.
  test("with no agent run going and production live but silent, the head card says so in a line, not an empty box", async () => {
    putEnv("production", {
      live: {
        commitOid: "d0d0d0d0",
        handle: { port: 4501 },
        runId: "irrelevant",
        since: new Date().toISOString(),
        manifest: { tty: null },
      },
    });
    const page = await (await get("/alice/kindling", owner)).text();
    expect(page).toContain('id="app-run-tail"');
    expect(page).not.toContain('class="run-log');
    expect(page).toContain("Production is quiet");
    // Still nothing to fetch — the page keeps polling in case that changes.
    expect(page).toMatch(/<meta\s+http-equiv="refresh"/);
  });
});

/**
 * Issue #284: production keeps writing to the same run's log for as long as
 * its process runs, long after the deploy that produced it is finished —
 * the head card's tail follows that, not just a deploy in flight.
 */
describe("the app's page tails production's own output while it runs (#284)", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let runtime: AppsRuntime;
  let repo: Repo;
  let record: AppRecord;
  let owner: string;
  let strangerCookie: string;
  let scoutId: string;

  interface PreviewSlot {
    readonly app: AppRecord;
    readonly env: EnvName;
    readonly chain: Promise<void>;
    readonly restarts: number[];
    deploying?: unknown;
    live?: unknown;
    lastError?: string;
    lastRunId?: string;
  }
  const putEnv = (
    env: EnvName,
    slot: Omit<PreviewSlot, "app" | "env" | "chain" | "restarts">,
  ): void => {
    (runtime as unknown as { envs: Map<string, PreviewSlot> }).envs.set(
      `${record.id}/${env}`,
      { app: record, env, chain: Promise.resolve(), restarts: [], ...slot },
    );
  };

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

  const get = (path: string, cookie: string) =>
    fetch(`${base}${path}`, {
      headers: { cookie: `${cookie}; forge_mode=studio` },
      redirect: "manual",
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-studio-live-tail-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    runtime = new AppsRuntime(app, {
      domain: "livetail.test",
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 1,
    });
    const a = await createUser(app.db, { trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    const c = await createUser(app.db, { trusted: true,
      username: "carol",
      email: "carol@forge.local",
      password: "a-good-passphrase",
    });
    if (!c.ok) throw new Error(c.error);
    owner = await signIn("alice");
    strangerCookie = await signIn("carol");
    const made = await createRepo(app, a.value, {
      name: "furnace",
      visibility: "public",
      description: "an app that keeps a fire going",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, a.value, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "furnace\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, a.value, repo, { slug: "furnace" });
    if (!enabled.ok) throw new Error(String(enabled.error));
    record = getAppByRepo(app.db, repo.id)!;
    const scout = await createAgent(app, a.value, { username: "scout" });
    if (!scout.ok) throw new Error(String(scout.error));
    scoutId = scout.value.user.id;
    expect(addToCrew(app, a.value, repo, "scout").ok).toBe(true);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("production running with lines in its log carries the tail, named as the app's own", async () => {
    const deployRun = createRun(app.db, {
      repoId: repo.id,
      kind: "deploy",
      env: "production",
      commitOid: "b16b00b5",
      reason: "push",
    });
    claimRun(app.db, deployRun.id);
    for (let i = 0; i < 9; i++)
      appendRunLog(app.config.dataDir, deployRun.id, `serving request ${i}`);
    finishRun(app.db, deployRun.id, { state: "ok", summary: "deploy" });
    putEnv("production", {
      live: {
        commitOid: "b16b00b5",
        handle: { port: 4503 },
        runId: deployRun.id,
        since: new Date().toISOString(),
        manifest: { tty: null },
      },
    });

    const page = await (await get("/alice/furnace", owner)).text();
    expect(page).toContain('id="app-run-tail"');
    expect(page).toContain('data-who="the app"');
    expect(page).toContain(
      `data-stream="/api/v1/repos/alice/furnace/runs/${deployRun.id}/log?follow=1"`,
    );
    expect(page).not.toContain(">serving request 0<");
    expect(page).toContain(">serving request 8<");
    expect(page).toContain("Holding the last 6 lines here");
    expect(page).toMatch(/<meta\s+http-equiv="refresh"/);

    // Issue #284's own point: the run this reads from is long finished —
    // the tail follows the env that points at it, not the run's own state.
    expect(getRun(app.db, deployRun.id)?.state).toBe("ok");
  });

  test("a viewer who cannot see the owner's facts gets no output at all", async () => {
    const response = await get("/alice/furnace", strangerCookie);
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).not.toContain('id="app-run-tail"');
    expect(page).not.toContain("serving request");
  });

  test("an agent run at work still outranks production's own tail", async () => {
    const tell = openIssue(app, getUserByName(app.db, "alice")!, repo, {
      title: "Add a chimney",
    });
    if (!tell.ok) throw new Error(String(tell.error));
    const agentRun = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: tell.value.id,
      actorId: scoutId,
      reason: "assigned",
    });
    claimRun(app.db, agentRun.id);
    appendRunLog(app.config.dataDir, agentRun.id, "scout is on it");

    const page = await (await get("/alice/furnace", owner)).text();
    expect(page.match(/id="app-run-tail"/g)?.length).toBe(1);
    expect(page).not.toContain('data-who="the app"');
    expect(page).toContain(
      `data-stream="/api/v1/repos/alice/furnace/runs/${agentRun.id}/log?follow=1"`,
    );

    finishRun(app.db, agentRun.id, { state: "ok", summary: "planned" });
  });
});

/**
 * Issue #163: "Now" is built from agent runs alone, so a fresh app with a
 * deploy going and nothing else read as if nothing were happening — right
 * beside the head card tailing that very deploy. "Now"'s empty state now
 * says otherwise when the head card is tailing a deploy, and keeps its
 * ordinary wording when nothing at all is going.
 */
describe(`"Now" while production is coming up and nothing else is`, () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let runtime: AppsRuntime;
  let repo: Repo;
  let record: AppRecord;
  let owner: string;

  interface PreviewSlot {
    readonly app: AppRecord;
    readonly env: EnvName;
    readonly chain: Promise<void>;
    readonly restarts: number[];
    deploying?: unknown;
    live?: unknown;
    lastError?: string;
    lastRunId?: string;
  }
  const putEnv = (
    env: EnvName,
    slot: Omit<PreviewSlot, "app" | "env" | "chain" | "restarts">,
  ): void => {
    (runtime as unknown as { envs: Map<string, PreviewSlot> }).envs.set(
      `${record.id}/${env}`,
      { app: record, env, chain: Promise.resolve(), restarts: [], ...slot },
    );
  };

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

  const get = (path: string, cookie: string) =>
    fetch(`${base}${path}`, {
      headers: { cookie: `${cookie}; forge_mode=studio` },
      redirect: "manual",
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-studio-now-empty-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    runtime = new AppsRuntime(app, {
      domain: "nowempty.test",
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 1,
    });
    const a = await createUser(app.db, { trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    owner = await signIn("alice");
    const made = await createRepo(app, a.value, {
      name: "ember",
      visibility: "private",
      description: "a new app",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, a.value, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "ember\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, a.value, repo, { slug: "ember" });
    if (!enabled.ok) throw new Error(String(enabled.error));
    record = getAppByRepo(app.db, repo.id)!;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test('a running deploy and no agent run: "Now" does not say nothing is happening, and opens no second tail', async () => {
    const deployRun = createRun(app.db, {
      repoId: repo.id,
      kind: "deploy",
      env: "production",
      commitOid: "eae580a",
      reason: "boot",
    });
    claimRun(app.db, deployRun.id);
    appendRunLog(app.config.dataDir, deployRun.id, "deploy in progress");
    putEnv("production", {
      deploying: {
        run: { id: deployRun.id, commitOid: "eae580a" },
        abort: new AbortController(),
      },
    });

    const page = await (await get("/alice/ember", owner)).text();
    expect(page).not.toContain("Nothing yet");
    expect(page).toContain("Production is coming up");
    // Exactly one tail on the page — the head card's, not a second one in
    // "Now".
    expect(page.match(/id="app-run-tail"/g)?.length).toBe(1);

    finishRun(app.db, deployRun.id, { state: "ok", summary: "deploy" });
  });

  test('with nothing going at all, "Now" reads exactly as it does today — production live and silent says its own quiet line above, not through "Now"', async () => {
    putEnv("production", {
      live: {
        commitOid: "eae580a",
        handle: { port: 4502 },
        runId: "irrelevant",
        since: new Date().toISOString(),
        manifest: { tty: null },
      },
    });

    const page = await (await get("/alice/ember", owner)).text();
    expect(page).toContain("Nothing yet. Tell the crew something.");
    // The head card's own quiet line (#284) is not the deploy-in-progress
    // wording "Now" uses — production here is live, not coming up.
    expect(page).not.toContain("Production is coming up");
    expect(page).toContain("Production is quiet");
  });
});

/**
 * Issue #183: `tellCrew` cannot route a tell to anyone with nobody on the
 * crew — the issue it opens stays unassigned forever, not merely
 * unpicked-up like an agent-held tell. Both surfaces that used to call this
 * "quiet" or "nothing yet" must say the honest reason instead, and both
 * failed before this change.
 */
describe('a tell nobody on the crew can take is not "quiet"', () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let repo: Repo;
  let alice: User;
  let cookie: string;

  const get = (path: string) =>
    fetch(`${base}${path}`, {
      headers: { cookie: `${cookie}; forge_mode=studio` },
      redirect: "manual",
    });
  const post = (path: string, body: Record<string, string>) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams(body),
      redirect: "manual",
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-studio-untaken-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, { trusted: true,
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
    const made = await createRepo(app, alice, {
      name: "pad",
      visibility: "private",
      description: "a pad for notes",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "pad\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, alice, repo, { slug: "pad" });
    if (!enabled.ok) throw new Error(String(enabled.error));
    // No crew at all — the exact state `tellCrew` cannot route out of.
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test('a crewless tell renders a "Now" row, not the empty state, and links to where a crew member is added', async () => {
    const told = await post("/alice/pad/tell", {
      text: "Add a dark mode toggle.",
    });
    expect(told.status).toBe(303);

    const page = await (await get("/alice/pad")).text();
    expect(page).not.toContain("Nothing yet. Tell the crew something.");
    expect(page).toContain("Add a dark mode toggle.");
    expect(page).toContain("nobody on the crew to take it");
    expect(page).toContain(`href="/alice/pad/settings"`);
  });

  test('the shelf row for that app is not "quiet"', async () => {
    const home = await (await get("/")).text();
    const at = home.indexOf('href="/alice/pad"');
    expect(at).toBeGreaterThan(-1);
    const start = home.lastIndexOf("<li>", at);
    const shelfRow = home.slice(start, home.indexOf("</li>", at) + 5);
    expect(shelfRow).not.toContain("quiet — tell the crew something");
    expect(shelfRow).toContain("nobody on the crew to take it");
  });

  test("a reader of the public app sees the fact, not the owner's invitation or a link to settings", async () => {
    app.db.run("UPDATE repo SET visibility = 'public' WHERE id = ?", [
      repo.id,
    ]);
    const b = await createUser(app.db, { trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    const bobCookie = (
      (
        await fetch(`${base}/signin`, {
          method: "POST",
          body: new URLSearchParams({
            username: "bob",
            password: "a-good-passphrase",
          }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
    const read = await (
      await fetch(`${base}/alice/pad`, {
        headers: { cookie: `${bobCookie}; forge_mode=studio` },
      })
    ).text();
    expect(read).toContain("Add a dark mode toggle.");
    expect(read).toContain("nobody on the crew to take it");
    expect(read).not.toContain("add someone");
    expect(read).not.toContain(`href="/alice/pad/settings"`);
    // The writer still gets the invitation, link included.
    const write = await (await get("/alice/pad")).text();
    expect(write).toContain("add someone");
    expect(write).toContain(`href="/alice/pad/settings"`);
  });
});

/**
 * Issue #226: taking a tell yourself — assigning it to a person, not an
 * agent — used to drop it clean off "Now": the panel's filter only ever
 * let an agent-held or unassigned tell through, so a person holding it
 * counted as nobody. `tellWord`'s own fallback said "not picked up yet"
 * regardless, so the tell's own page agreed with nothing true either.
 * Both failed before this change.
 */
describe("a tell held by a person still shows on the front door (#226)", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let repo: Repo;
  let alice: User;
  let cookie: string;
  let tell: Issue;

  const get = (path: string) =>
    fetch(`${base}${path}`, {
      headers: { cookie: `${cookie}; forge_mode=studio` },
      redirect: "manual",
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-studio-person-held-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, { trusted: true,
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
    const made = await createRepo(app, alice, {
      name: "pad",
      visibility: "private",
      description: "a pad for notes",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "pad\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, alice, repo, { slug: "pad" });
    if (!enabled.ok) throw new Error(String(enabled.error));
    const scout = await createAgent(app, alice, { username: "scout" });
    if (!scout.ok) throw new Error(String(scout.error));
    expect(addToCrew(app, alice, repo, "scout").ok).toBe(true);

    const told = openIssue(app, alice, repo, {
      title: "Give the header a subtitle",
    });
    if (!told.ok) throw new Error(String(told.error));
    tell = told.value;
    // Taken by a person — the owner herself — not routed to the crew.
    expect(assignIssue(app, alice, repo, tell, alice).ok).toBe(true);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test('"Now" names the person who holds it, not "Nothing yet"', async () => {
    const page = await (await get("/alice/pad")).text();
    expect(page).not.toContain("Nothing yet. Tell the crew something.");
    expect(page).toContain("Give the header a subtitle");
    expect(page).toContain("alice");
    expect(page).not.toContain("not picked up yet");
  });

  test("the tell's own page agrees with the panel: held, not unpicked", async () => {
    const page = await (await get(`/alice/pad/issues/${tell.number}`)).text();
    expect(page).not.toContain("not picked up yet");
    expect(page).toContain(">alice</a>");
    expect(page).toContain("has it");
  });
});

/**
 * Issue #191: `appShelf`/`shelfRows` used to derive a row from agent runs
 * alone, so a change a person opened by hand — no run anywhere near it —
 * fell to "quiet — tell the crew something" even while it sat green and
 * ready for a look, and "Happening now" said nobody was working while that
 * same change waited. Both read from `openPullsForRepos` now, grouped once
 * for the whole shelf, so a person's own change counts exactly as an
 * agent's does. Failed before this change.
 */
describe("an open change is never quiet on the front door", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let repo: Repo;
  let alice: User;
  let cookie: string;
  let pull: Pull;

  const get = (path: string) =>
    fetch(`${base}${path}`, {
      headers: { cookie: `${cookie}; forge_mode=studio` },
      redirect: "manual",
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-studio-open-change-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, { trusted: true,
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
    const made = await createRepo(app, alice, {
      name: "pad",
      visibility: "private",
      description: "a pad for notes",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "pad\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, alice, repo, { slug: "pad" });
    if (!enabled.ok) throw new Error(String(enabled.error));

    // Alice opens the change herself, through the editor — no agent run
    // anywhere near it, the exact case `latestAgentRunsForRepos` misses.
    const branch = await commitToBranch(app, alice, repo, {
      branch: "note",
      base: "main",
      message: "A note",
      files: [{ path: "NOTE.md", content: "note\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "A note",
      body: "",
      baseBranch: "main",
      headBranch: "note",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    pull = opened.value;
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

    // A second app, otherwise identical, with nothing open at all — the
    // control that must keep reading "quiet".
    const madeQuiet = await createRepo(app, alice, {
      name: "quiet",
      visibility: "private",
      description: "says nothing",
    });
    if (!madeQuiet.ok) throw new Error(String(madeQuiet.error));
    const seededQuiet = await commitToBranch(app, alice, madeQuiet.value, {
      message: "Start",
      files: [{ path: "README.md", content: "quiet\n" }],
    });
    if (!seededQuiet.ok) throw new Error(JSON.stringify(seededQuiet.error));
    const enabledQuiet = await enableApp(app, alice, madeQuiet.value, {
      slug: "quiet",
    });
    if (!enabledQuiet.ok) throw new Error(String(enabledQuiet.error));
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the shelf row carries the change's own word, its badge and dot kept", async () => {
    const home = await (await get("/")).text();
    const at = home.indexOf('href="/alice/pad"');
    expect(at).toBeGreaterThan(-1);
    const start = home.lastIndexOf("<li>", at);
    const shelfRow = home.slice(start, home.indexOf("</li>", at) + 5);
    expect(shelfRow).not.toContain("quiet — tell the crew something");
    expect(shelfRow).toContain('data-word="look"');
    expect(shelfRow).toContain('class="dot"');
    expect(shelfRow).toContain('class="badge"');
  });

  test("an app with nothing open still reads quiet", async () => {
    const home = await (await get("/")).text();
    const at = home.indexOf('href="/alice/quiet"');
    expect(at).toBeGreaterThan(-1);
    const start = home.lastIndexOf("<li>", at);
    const shelfRow = home.slice(start, home.indexOf("</li>", at) + 5);
    expect(shelfRow).toContain("quiet — tell the crew something");
  });
});

/**
 * Issue #215: once a merged change closes, it drops out of
 * `openPullsForRepos`, and before this the shelf and the rail had nothing
 * left to say about it but "quiet" — the row's *happening* half spoke only
 * for an agent run, never a deploy. `productionFact` (`words.ts`) reads
 * production's own status for the fact a merge or a push leaves behind:
 * the deploy that landed, or one that failed behind what still serves.
 */
describe("a deploy that just landed is news on the front door", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let runtime: AppsRuntime;
  let repo: Repo;
  let record: AppRecord;
  let quietRepo: Repo;
  let alice: User;
  let cookie: string;
  let deployRun: Run;

  interface PreviewSlot {
    readonly app: AppRecord;
    readonly env: EnvName;
    readonly chain: Promise<void>;
    readonly restarts: number[];
    deploying?: unknown;
    live?: unknown;
    lastError?: string;
    lastRunId?: string;
  }
  const putEnv = (
    appRecord: AppRecord,
    env: EnvName,
    slot: Omit<PreviewSlot, "app" | "env" | "chain" | "restarts">,
  ): void => {
    (runtime as unknown as { envs: Map<string, PreviewSlot> }).envs.set(
      `${appRecord.id}/${env}`,
      { app: appRecord, env, chain: Promise.resolve(), restarts: [], ...slot },
    );
  };

  const get = (path: string) =>
    fetch(`${base}${path}`, {
      headers: { cookie: `${cookie}; forge_mode=studio` },
      redirect: "manual",
    });

  const shelfRowFor = (home: string, href: string): string => {
    const at = home.indexOf(`href="${href}"`);
    expect(at).toBeGreaterThan(-1);
    const start = home.lastIndexOf("<li>", at);
    return home.slice(start, home.indexOf("</li>", at) + 5);
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-studio-shipped-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    // Uncalled `.start()`: this runtime never subscribes to the bus, so
    // nothing here spins a real process — its `envs` are only ever what
    // `putEnv` puts there, the same fiction the live-fragment tests use.
    runtime = new AppsRuntime(app, {
      domain: "shipped.test",
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 1,
    });
    const a = await createUser(app.db, { trusted: true,
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

    const made = await createRepo(app, alice, {
      name: "sap",
      visibility: "private",
      description: "a sap for notes",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "sap\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, alice, repo, { slug: "sap" });
    if (!enabled.ok) throw new Error(String(enabled.error));
    record = getAppByRepo(app.db, repo.id)!;

    deployRun = createRun(app.db, {
      repoId: repo.id,
      kind: "deploy",
      env: "production",
      commitOid: "6c99218",
      reason: "merge",
      actorId: alice.id,
    });
    claimRun(app.db, deployRun.id);
    deployRun =
      finishRun(app.db, deployRun.id, { state: "ok", summary: "deploy" }) ??
      deployRun;
    const servingAt = new Date().toISOString();
    putEnv(record, "production", {
      live: {
        commitOid: "6c99218",
        handle: { port: 4321 },
        runId: deployRun.id,
        since: servingAt,
        servingAt,
        createdAt: servingAt,
        manifest: { tty: null },
      },
    });

    // A second app, otherwise identical, that never shipped — the control
    // that must keep reading quiet.
    const madeQuiet = await createRepo(app, alice, {
      name: "quiet2",
      visibility: "private",
      description: "says nothing",
    });
    if (!madeQuiet.ok) throw new Error(String(madeQuiet.error));
    const seededQuiet = await commitToBranch(app, alice, madeQuiet.value, {
      message: "Start",
      files: [{ path: "README.md", content: "quiet\n" }],
    });
    if (!seededQuiet.ok) throw new Error(JSON.stringify(seededQuiet.error));
    const enabledQuiet = await enableApp(app, alice, madeQuiet.value, {
      slug: "quiet2",
    });
    if (!enabledQuiet.ok) throw new Error(String(enabledQuiet.error));
    quietRepo = madeQuiet.value;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the shelf row reads shipped, with who and when, not quiet", async () => {
    const home = await (await get("/")).text();
    const shelfRow = shelfRowFor(home, "/alice/sap");
    expect(shelfRow).not.toContain("quiet — tell the crew something");
    expect(shelfRow).toContain('data-word="shipped"');
    expect(shelfRow).toContain("alice");
  });

  test("an app with no recent deploy still reads quiet", async () => {
    const home = await (await get("/")).text();
    const shelfRow = shelfRowFor(home, `/alice/${quietRepo.name}`);
    expect(shelfRow).toContain("quiet — tell the crew something");
  });

  test("a deploy no push asked for is not news: a redeploy or the boot reconcile does not read shipped", async () => {
    const restartedAt = new Date().toISOString();
    putEnv(record, "production", {
      live: {
        commitOid: "6c99218",
        handle: { port: 4321 },
        runId: deployRun.id,
        since: restartedAt,
        servingAt: restartedAt,
        // No `createdAt`: nothing asked a push for this one — a redeploy
        // someone pressed, or the boot reconcile every restart runs.
        manifest: { tty: null },
      },
    });
    const home = await (await get("/")).text();
    const shelfRow = shelfRowFor(home, "/alice/sap");
    expect(shelfRow).not.toContain('data-word="shipped"');
    expect(shelfRow).toContain("quiet — tell the crew something");
  });

  test("a deploy older than the news window reads quiet again, not shipped forever", async () => {
    const old = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    putEnv(record, "production", {
      live: {
        commitOid: "6c99218",
        handle: { port: 4321 },
        runId: deployRun.id,
        since: old,
        servingAt: old,
        createdAt: old,
        manifest: { tty: null },
      },
    });
    const home = await (await get("/")).text();
    const shelfRow = shelfRowFor(home, "/alice/sap");
    expect(shelfRow).not.toContain('data-word="shipped"');
    expect(shelfRow).toContain("quiet — tell the crew something");
  });
});

/**
 * Issue #65: a public app's studio page is the app, not the owner's books.
 * `canSeeOwnerFacts` (`src/core/repos.ts`) is the one predicate — the same
 * as `canWrite` today — that every surface carrying money, the crew or the
 * decision ledger must ask before it computes or renders one of those.
 */
describe("a stranger sees the app, not the owner's books", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let repo: Repo;
  let alice: User;
  let ownerCookie: string;
  let strangerCookie: string;
  let run: Run;

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

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-studio-public-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, { trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const c = await createUser(app.db, { trusted: true,
      username: "carol",
      email: "carol@forge.local",
      password: "a-good-passphrase",
    });
    if (!c.ok) throw new Error(c.error);
    ownerCookie = await signIn("alice");
    strangerCookie = await signIn("carol");
    const made = await createRepo(app, alice, {
      name: "beacon",
      visibility: "public",
      description: "a light that stays on",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "beacon\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, alice, repo, { slug: "beacon" });
    if (!enabled.ok) throw new Error(String(enabled.error));
    const scout = await createAgent(app, alice, { username: "keeper" });
    if (!scout.ok) throw new Error(String(scout.error));
    expect(addToCrew(app, alice, repo, "keeper").ok).toBe(true);
    const on = await updateRepoSettings(app, alice, repo, {
      autonomy: "assisted",
      autonomyDirection: "",
      autonomyCeilingUsd: 25,
      autonomySlots: 2,
      autonomyBy: alice.id,
    });
    expect(on.ok).toBe(true);

    const tell = openIssue(app, alice, repo, { title: "Trim the wick" });
    if (!tell.ok) throw new Error(String(tell.error));
    const branch = await commitToBranch(app, alice, repo, {
      branch: "keeper/trim-the-wick",
      base: "main",
      message: "Trim the wick",
      files: [{ path: "WICK.md", content: "trim\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "Trim the wick",
      body: `Closes #${tell.value.number}`,
      baseBranch: "main",
      headBranch: "keeper/trim-the-wick",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const keeperId = getUserByName(app.db, "keeper")!.id;
    run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: tell.value.id,
      branch: "keeper/trim-the-wick",
      actorId: keeperId,
      reason: "assigned",
    });
    claimRun(app.db, run.id);
    run =
      finishRun(app.db, run.id, {
        state: "ok",
        summary: `opened pull #${opened.value.number}`,
        costUsd: 42.5,
        turns: 7,
      }) ?? run;
    const merged = await mergePull(app, alice, repo, opened.value, "squash");
    if (!merged.ok) throw new Error(String(merged.error));
    recordDecision(app.db, {
      kind: "land",
      repoId: repo.id,
      issueId: tell.value.id,
      state: { card: "ask", head: opened.value.headOid },
      answer: "ship",
      p: 0.9,
      by: "rule",
      ms: 3,
    });

    // Three served deploys this week, median 4.0s, and a fourth that never
    // answered — excluded, not a zero that would drag the median down.
    const now = Date.now();
    for (const [offsetMs, durationMs] of [
      [0, 2_000],
      [1_000, 4_000],
      [2_000, 6_000],
      [3_000, null],
    ] as const) {
      const deploy = createRun(app.db, {
        repoId: repo.id,
        kind: "deploy",
        env: "production",
        commitOid: "cafefeed",
        reason: "push",
      });
      app.db
        .query("UPDATE run SET created_at = ?2 WHERE id = ?1")
        .run(deploy.id, new Date(now + offsetMs).toISOString());
      if (durationMs !== null) {
        app.db
          .query("UPDATE run SET serving_at = ?2 WHERE id = ?1")
          .run(deploy.id, new Date(now + offsetMs + durationMs).toISOString());
      }
    }
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("anonymous and read-only visitors get the app, not the owner's numbers; the owner still gets everything", async () => {
    const anon = await (await get("/alice/beacon")).text();
    const stranger = await (await get("/alice/beacon", strangerCookie)).text();
    const owner = await (await get("/alice/beacon", ownerCookie)).text();

    for (const page of [anon, stranger]) {
      expect(page).not.toMatch(/\$\d/);
      expect(page).not.toContain("keeper");
      expect(page).not.toContain(">Decided<");
      expect(page).not.toContain(">On its own<");
      expect(page).not.toContain(">Slots<");
      expect(page).not.toContain("Nobody yet");
      // The app itself is still there: what it is, that it shipped, a way in.
      expect(page).toContain("a light that stays on");
      expect(page).toContain(">Shipped<");
      expect(page).toContain("1 change");
      expect(page).toContain("Open the app");
      // The direction's own number is the same owner's-books fact as spend
      // and the ledger: a stranger and an anonymous visitor see neither.
      expect(page).not.toContain(">Preview<");
      expect(page).not.toContain("reaches its preview");
    }

    expect(owner).toContain("$42.50");
    expect(owner).toContain("keeper");
    expect(owner).toContain(">On its own<");
    expect(owner).toContain(">Decided<");
    // Three served deploys this week — 2.0s, 4.0s and 6.0s — median 4.0s;
    // the fourth, never served, does not drag it toward zero.
    expect(owner).toContain("reaches its preview in 4.0s");
    expect(owner).toContain("· 3 deploys");
  });

  test("the app's live fragment carries no owner fact either", async () => {
    const fragment = await (await get("/alice/beacon/app/state")).text();
    expect(fragment).not.toMatch(/\$\d/);
    expect(fragment).not.toContain("keeper");
  });

  test("a run's own page hides cost, turns and the crew's name from a stranger and from an anonymous reader; the JSON API redacts the run the same way", async () => {
    const anonPage = await (await get(`/alice/beacon/runs/${run.id}`)).text();
    const strangerPage = await (
      await get(`/alice/beacon/runs/${run.id}`, strangerCookie)
    ).text();
    for (const page of [anonPage, strangerPage]) {
      expect(page).not.toContain("$42.50");
      expect(page).not.toContain("7 turns");
      expect(page).not.toContain("keeper");
      expect(page).toContain('data-who="the crew"');
    }
    const ownerPage = await (
      await get(`/alice/beacon/runs/${run.id}`, ownerCookie)
    ).text();
    expect(ownerPage).toContain("$42.50");
    expect(ownerPage).toContain("7 turns");
    expect(ownerPage).toContain('data-who="keeper"');

    const asStranger = (await (
      await get(`/api/v1/repos/alice/beacon/runs/${run.id}`, strangerCookie)
    ).json()) as { costUsd: number; turns: number };
    expect(asStranger.costUsd).toBe(0);
    expect(asStranger.turns).toBe(0);
    const asOwner = (await (
      await get(`/api/v1/repos/alice/beacon/runs/${run.id}`, ownerCookie)
    ).json()) as { costUsd: number; turns: number };
    expect(asOwner.costUsd).toBe(42.5);
    expect(asOwner.turns).toBe(7);

    const listAsStranger = (await (
      await get(`/api/v1/repos/alice/beacon/runs`, strangerCookie)
    ).json()) as { items: { costUsd: number }[] };
    expect(listAsStranger.items.every((r) => r.costUsd === 0)).toBe(true);

    const tailAsStranger = await (
      await get(
        `/api/v1/repos/alice/beacon/runs/${run.id}/log?follow=1`,
        strangerCookie,
      )
    ).text();
    expect(tailAsStranger).toContain("event: done");
    // The cost by its key, not its digits: a timestamp's seconds can read
    // "42.5" too, and once did.
    expect(tailAsStranger).not.toContain('"costUsd":42.5');
    expect(tailAsStranger).toContain('"costUsd":0');
    const tailAsOwner = await (
      await get(
        `/api/v1/repos/alice/beacon/runs/${run.id}/log?follow=1`,
        ownerCookie,
      )
    ).text();
    expect(tailAsOwner).toContain("42.5");
  });

  test("the studio home names the crew for the owner, but only 'the crew' for a signed-in reader of the same public app", async () => {
    const asStranger = await (await get("/", strangerCookie)).text();
    expect(asStranger).not.toContain("keeper");
    expect(asStranger).toContain("beacon");
    const asOwner = await (await get("/", ownerCookie)).text();
    expect(asOwner).toContain("keeper");
    expect(asOwner).toContain("beacon");
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

  test("an autonomous app with nobody on its crew says so beside the mode, and stops saying it once a builder joins", async () => {
    const made = await createRepo(app, alice, { name: "lamp", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const lamp = made.value;
    const seeded = await commitToBranch(app, alice, lamp, {
      message: "Start",
      files: [{ path: "README.md", content: "lamp\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, alice, lamp, { slug: "lamp" });
    if (!enabled.ok) throw new Error(String(enabled.error));
    const on = await updateRepoSettings(app, alice, lamp, {
      autonomy: "autonomous",
      autonomyDirection: "",
      autonomyCeilingUsd: 5,
      autonomySlots: 1,
      autonomyBy: alice.id,
    });
    expect(on.ok).toBe(true);

    const empty = await (await get("/alice/lamp", ownerCookie)).text();
    expect(empty).toContain("Autonomous");
    expect(empty).toContain("nobody on the crew");
    expect(empty).toContain('href="/alice/lamp/settings">Put someone on the crew');
    // The shelf's stuck word and this card share one phrase.
    expect(NOBODY_ON_CREW).toBe("nobody on the crew");

    const crewed = await (await get("/alice/beacon", ownerCookie)).text();
    expect(crewed).not.toContain("nobody on the crew");

    const agent = await createAgent(app, alice, { username: "wick" });
    if (!agent.ok) throw new Error(String(agent.error));
    expect(addToCrew(app, alice, lamp, "wick").ok).toBe(true);
    const joined = await (await get("/alice/lamp", ownerCookie)).text();
    expect(joined).not.toContain("nobody on the crew");
  });

  test("the studio's settings page renders the crew and the ceiling for a writer, with the same numbers the app page shows", async () => {
    const owner = await (
      await get("/alice/beacon/settings", ownerCookie)
    ).text();
    expect(owner).toContain("keeper");
    expect(owner).toContain(">Crew<");
    expect(owner).toContain(">On its own<");
    expect(owner).toMatch(/\$42\.50\s+of\s+\$25/);
    expect(owner).toContain("Remove");
    expect(owner).toContain("Save");
    // The rest is beneath, on the same page and in the same frame.
    expect(owner).toContain("<h2>Branch and gates</h2>");
    expect(owner.indexOf(">On its own<")).toBeLessThan(
      owner.indexOf("<h2>Branch and gates</h2>"),
    );
    expect(owner).toContain('href="/alice/beacon/settings/labels"');
    expect(owner).not.toContain("?mode=dev");
  });

  test("a reader without write sees no crew and no controls on the settings page; one who cannot read gets not-found", async () => {
    const stranger = await (
      await get("/alice/beacon/settings", strangerCookie)
    ).text();
    expect(stranger).not.toContain("keeper");
    expect(stranger).not.toMatch(/\$\d/);
    expect(stranger).not.toContain("Add to crew");
    expect(stranger).not.toContain("<select");

    const anon = await get("/alice/beacon/settings");
    expect(anon.status).toBe(200);
    const anonText = await anon.text();
    expect(anonText).not.toContain("keeper");

    const noSuchRepo = await get("/alice/no-such-app/settings", strangerCookie);
    expect(noSuchRepo.status).toBe(404);
  });

  test("a reader's post to the crew action is refused, exactly as dev's page refuses it", async () => {
    const refused = await post(
      "/alice/beacon/settings/crew",
      { agent: "keeper" },
      strangerCookie,
    );
    expect(refused.status).toBe(404);
  });

  test("a role change made from the studio settings page lands exactly as dev's page does", async () => {
    const roleChange = await post(
      "/alice/beacon/settings/crew/keeper/role",
      { role: "reviewer" },
      ownerCookie,
    );
    expect(roleChange.status).toBe(303);
    expect(roleChange.headers.get("location")).toBe(
      "/alice/beacon/settings#crew",
    );
    const after = await (
      await get("/alice/beacon/settings", ownerCookie)
    ).text();
    expect(after).toContain("reviews");
  });

  test("?mode=dev on the settings route is the same one page; dev's Crew and Autonomy addresses land on its cards", async () => {
    const dev = await (
      await get("/alice/beacon/settings?mode=dev", ownerCookie)
    ).text();
    expect(dev).toContain(">General<");
    expect(dev).toContain(">Crew<");
    expect(dev).toContain("Description");
    expect(dev).toContain("<h2>Branch and gates</h2>");
    expect(dev).toContain('id="f-direction"');

    for (const [old, to] of [
      ["/alice/beacon/settings/crew", "/alice/beacon/settings#crew"],
      ["/alice/beacon/settings/autonomy", "/alice/beacon/settings#autonomy"],
    ]) {
      const res = await get(old!, ownerCookie);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(to!);
    }
    // A reader who cannot see the repository gets not-found, not a hint.
    const hidden = await get("/alice/no-such-app/settings/crew", ownerCookie);
    expect(hidden.status).toBe(404);
  });
});

/**
 * Issue #211: the studio's own Decide card ships a person's own change too,
 * not only the crew's — the same `/ship` route, the same conflict wording
 * (`change.ts:145-157` before this), offered to a writer, whoever opened it.
 */
describe("a person's own change ships from its own studio page", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
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

  const get = (path: string, cookie: string) =>
    fetch(`${base}${path}`, {
      headers: { cookie: `${cookie}; forge_mode=studio` },
      redirect: "manual",
    });
  const post = (path: string, cookie: string) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { cookie, origin: base },
      redirect: "manual",
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-own-ship-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, { trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const r = await createUser(app.db, { trusted: true,
      username: "eve",
      email: "eve@forge.local",
      password: "a-good-passphrase",
    });
    if (!r.ok) throw new Error(r.error);
    ownerCookie = await signIn("alice");
    readerCookie = await signIn("eve");
    const made = await createRepo(app, alice, {
      name: "garden",
      visibility: "public",
      description: "grown by hand, not by the crew",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [
        {
          path: "package.json",
          content:
            '{"name":"garden","scripts":{"start":"bun run server.ts"}}\n',
        },
        {
          path: "server.ts",
          content:
            "Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('ok') });\n",
        },
      ],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, alice, repo, { slug: "garden" });
    if (!enabled.ok) throw new Error(String(enabled.error));
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a green change alice opened herself offers Ship to a writer, and nothing to a reader; shipping lands it and the page reads shipped", async () => {
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/bench",
      base: "main",
      message: "Add a bench",
      files: [{ path: "BENCH.md", content: "a place to sit\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "Add a bench",
      body: "For sitting.",
      baseBranch: "main",
      headBranch: "feature/bench",
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

    const readerPage = await (
      await get(`/alice/garden/pulls/${pull.number}`, readerCookie)
    ).text();
    expect(readerPage).toContain('data-word="look"');
    expect(readerPage).not.toContain("<h2>Decide</h2>");
    expect(readerPage).not.toContain("Ship");

    const ownerPage = await (
      await get(`/alice/garden/pulls/${pull.number}`, ownerCookie)
    ).text();
    expect(ownerPage).toContain("<h2>Decide</h2>");
    expect(ownerPage).toContain("Ship");
    // The words a person's own green change is offered in are `asks.ts`'s
    // (#224: a green change asks to be looked at whoever opened it, and the
    // card says so without pretending somebody finished it for them). The
    // `own` fallback in `studio/change.ts` — "The check is green." — is what
    // an autonomous repository's own pull still gets, where the asks panel
    // offers nothing.
    expect(ownerPage).toContain(
      "is green — ready for a look. Ship it, or say what is off.",
    );

    const shipped = await post(
      `/alice/garden/pulls/${pull.number}/ship`,
      ownerCookie,
    );
    expect(shipped.status).toBe(303);
    expect(getPull(app.db, repo.id, pull.number)?.mergedAt).not.toBeNull();
    const after = await (
      await get(`/alice/garden/pulls/${pull.number}`, ownerCookie)
    ).text();
    expect(after).toContain('data-word="shipped"');
  });

  test("a conflicted change alice opened herself offers the bring-up-to-date wording, never a Ship that would be refused", async () => {
    const base1 = await commitToBranch(app, alice, repo, {
      message: "Add a file two branches will fight over",
      files: [{ path: "CONFLICT.md", content: "base\n" }],
    });
    if (!base1.ok) throw new Error(JSON.stringify(base1.error));
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/own-conflict",
      base: "main",
      message: "Alice's edit",
      files: [{ path: "CONFLICT.md", content: "base\nalice\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const onMain = await commitToBranch(app, alice, repo, {
      message: "Main's edit",
      files: [{ path: "CONFLICT.md", content: "base\nmain\n" }],
    });
    if (!onMain.ok) throw new Error(JSON.stringify(onMain.error));

    const opened = await openPull(app, alice, repo, {
      title: "Alice's conflicting change",
      body: "This will not merge cleanly.",
      baseBranch: "main",
      headBranch: "feature/own-conflict",
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
      await get(`/alice/garden/pulls/${pull.number}`, ownerCookie)
    ).text();
    expect(studio).toContain("<h2>Decide</h2>");
    expect(studio).toContain("conflicts with main");
    expect(studio).toContain("bring the branch up to date");
    expect(studio).toContain("Bring up to date");
    expect(studio).not.toContain("Ship");
  });
});

/**
 * Issue #190: a shipped change's studio page offers Take it back to a
 * writer, behind the studio's existing confirm, and pressing it opens a new
 * change that undoes it.
 */
describe("take it back: the studio's verb on a shipped change", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
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

  const get = (path: string, cookie: string) =>
    fetch(`${base}${path}`, {
      headers: { cookie: `${cookie}; forge_mode=studio` },
      redirect: "manual",
    });
  const post = (path: string, cookie: string, origin = base) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { cookie, origin },
      redirect: "manual",
    });

  const shipChange = async (
    branch: string,
    title: string,
    content: string,
  ): Promise<Pull> => {
    const committed = await commitToBranch(app, alice, repo, {
      branch,
      base: "main",
      message: title,
      files: [{ path: "code.txt", content }],
    });
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
    const opened = await openPull(app, alice, repo, {
      title,
      baseBranch: "main",
      headBranch: branch,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const merged = await mergePull(app, alice, repo, opened.value, "squash");
    if (!merged.ok) throw new Error(JSON.stringify(merged.error));
    return getPull(app.db, repo.id, opened.value.number)!;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-take-back-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, { trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const r = await createUser(app.db, { trusted: true,
      username: "eve",
      email: "eve@forge.local",
      password: "a-good-passphrase",
    });
    if (!r.ok) throw new Error(r.error);
    ownerCookie = await signIn("alice");
    readerCookie = await signIn("eve");
    const made = await createRepo(app, alice, {
      name: "orchard",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [
        {
          path: "package.json",
          content:
            '{"name":"orchard","scripts":{"start":"bun run server.ts"}}\n',
        },
        {
          path: "server.ts",
          content:
            "Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('ok') });\n",
        },
        { path: "code.txt", content: "alpha\n" },
      ],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, alice, repo, { slug: "orchard" });
    if (!enabled.ok) throw new Error(String(enabled.error));
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a shipped change offers Take it back to a writer, not to a reader, and not while it is still open", async () => {
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/loud",
      base: "main",
      message: "Make it loud",
      files: [{ path: "code.txt", content: "alpha\nBETA\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "Make it loud",
      baseBranch: "main",
      headBranch: "feature/loud",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;

    const whileOpen = await (
      await get(`/alice/orchard/pulls/${pull.number}`, ownerCookie)
    ).text();
    expect(whileOpen).not.toContain("Take it back");

    const merged = await mergePull(app, alice, repo, pull, "squash");
    if (!merged.ok) throw new Error(JSON.stringify(merged.error));

    const ownerPage = await (
      await get(`/alice/orchard/pulls/${pull.number}`, ownerCookie)
    ).text();
    expect(ownerPage).toContain("Take it back");
    expect(ownerPage).toContain(
      `/-/confirm?to=%2Falice%2Forchard%2Fpulls%2F${pull.number}%2Ftake-back`,
    );

    const readerPage = await (
      await get(`/alice/orchard/pulls/${pull.number}`, readerCookie)
    ).text();
    expect(readerPage).not.toContain("Take it back");

    const confirm = await (
      await get(
        `/-/confirm?to=${encodeURIComponent(`/alice/orchard/pulls/${pull.number}/take-back`)}`,
        ownerCookie,
      )
    ).text();
    expect(confirm).toContain("Take back");
    expect(confirm).toContain("Make it loud");
    expect(confirm).toContain(
      "opens a new change that undoes exactly what it shipped",
    );
  });

  test("pressing Take it back opens a new change and lands on its studio page", async () => {
    const shipped = await shipChange(
      "feature/gamma",
      "Add gamma",
      "alpha\nGAMMA\n",
    );

    const taken = await post(
      `/alice/orchard/pulls/${shipped.number}/take-back`,
      ownerCookie,
    );
    expect(taken.status).toBe(303);
    const location = taken.headers.get("location")!;
    expect(location).toBe(`/alice/orchard/pulls/${shipped.number + 1}`);

    const revertPage = await (await get(location, ownerCookie)).text();
    expect(revertPage).toContain(`Revert &quot;Add gamma&quot;`);
  });

  test("the POST is refused from another origin, and nothing is created", async () => {
    const shipped = await shipChange(
      "feature/delta",
      "Add delta",
      "alpha\nDELTA\n",
    );

    const forged = await post(
      `/alice/orchard/pulls/${shipped.number}/take-back`,
      ownerCookie,
      "https://evil.example",
    );
    expect(forged.status).toBe(403);
    expect(getPull(app.db, repo.id, shipped.number + 1)).toBeUndefined();
  });

  test("a refusal is said in the studio's own words, and takes nothing back twice", async () => {
    const shipped = await shipChange(
      "feature/epsilon",
      "Add epsilon",
      "alpha\nEPSILON\n",
    );
    const first = await post(
      `/alice/orchard/pulls/${shipped.number}/take-back`,
      ownerCookie,
    );
    expect(first.status).toBe(303);

    const again = await post(
      `/alice/orchard/pulls/${shipped.number}/take-back`,
      ownerCookie,
    );
    expect(again.status).toBe(303);
    const location = again.headers.get("location")!;
    expect(location).toBe(`/alice/orchard/pulls/${shipped.number}`);
    const flash = decodeURIComponent(again.headers.get("set-cookie") ?? "");
    expect(flash).toContain("already been taken back");

    // Only one revert pull exists — the second attempt created nothing.
    expect(getPull(app.db, repo.id, shipped.number + 1)?.title).toBe(
      'Revert "Add epsilon"',
    );
    expect(getPull(app.db, repo.id, shipped.number + 2)).toBeUndefined();
  });
});

describe("the studio's crew panel on a forge with no agents yet", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let ownerCookie: string;
  let teamAdminCookie: string;

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

  const get = (path: string, cookie: string) =>
    fetch(`${base}${path}`, {
      headers: { cookie: `${cookie}; forge_mode=studio` },
      redirect: "manual",
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-studio-no-agents-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, { trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    const alice = a.value;
    const b = await createUser(app.db, { trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    ownerCookie = await signIn("alice");
    teamAdminCookie = await signIn("bob");

    // alice's own app: she is both the repo's admin and the forge's.
    const pad = await createRepo(app, alice, {
      name: "pad",
      visibility: "public",
    });
    if (!pad.ok) throw new Error(String(pad.error));
    const padSeeded = await commitToBranch(app, alice, pad.value, {
      message: "Start",
      files: [{ path: "README.md", content: "pad\n" }],
    });
    if (!padSeeded.ok) throw new Error(JSON.stringify(padSeeded.error));
    const padEnabled = await enableApp(app, alice, pad.value, { slug: "pad" });
    if (!padEnabled.ok) throw new Error(String(padEnabled.error));

    // an org app whose team admin, bob, is not a forge admin.
    const org = await createOrg(app, alice, "acme");
    if (!org.ok) throw new Error(org.error);
    const team = await createTeam(app, alice, org.value, "leads", "admin");
    if (!team.ok) throw new Error(String(team.error));
    const added = await addTeamMember(app, alice, org.value, team.value, "bob");
    if (!added.ok) throw new Error(String(added.error));
    const vault = await createRepo(app, alice, {
      name: "vault",
      owner: "acme",
      visibility: "public",
    });
    if (!vault.ok) throw new Error(String(vault.error));
    const vaultSeeded = await commitToBranch(app, alice, vault.value, {
      message: "Start",
      files: [{ path: "README.md", content: "vault\n" }],
    });
    if (!vaultSeeded.ok) throw new Error(JSON.stringify(vaultSeeded.error));
    const vaultEnabled = await enableApp(app, alice, vault.value, {
      slug: "vault",
    });
    if (!vaultEnabled.ok) throw new Error(String(vaultEnabled.error));
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a forge admin sees the crew panel name the door an agent is made through, and reaches it in one click without leaving studio mode", async () => {
    const settings = await (
      await get("/alice/pad/settings", ownerCookie)
    ).text();
    expect(settings).toContain("No agents exist on this forge yet.");
    expect(settings).not.toContain("Add an agent below");
    expect(settings).toContain('href="/settings/crew"');

    const doorResponse = await get("/settings/crew", ownerCookie);
    expect(doorResponse.status).toBe(200);
    const crewPage = await doorResponse.text();
    expect(crewPage).toContain("New agent");
    expect(crewPage).toContain('action="/settings/crew"');
  });

  test("a repository admin who is not a forge admin is told who can add an agent, not sent to a page that refuses them", async () => {
    const settings = await (
      await get("/acme/vault/settings", teamAdminCookie)
    ).text();
    expect(settings).toContain(
      "No agents exist on this forge yet. An admin can add one.",
    );
    expect(settings).not.toContain('href="/settings/crew"');

    const refused = await get("/settings/crew", teamAdminCookie);
    expect(refused.status).toBe(404);
  });

  test("the app page's 'Add someone' leads unbroken to the door an agent is made through, with nothing dev-only in the way", async () => {
    const appPage = await (await get("/alice/pad", ownerCookie)).text();
    expect(appPage).toContain("Nobody yet");
    expect(appPage).toContain('href="/alice/pad/settings">Add someone.');

    const settings = await (
      await get("/alice/pad/settings", ownerCookie)
    ).text();
    expect(settings).toContain('href="/settings/crew"');

    const door = await get("/settings/crew", ownerCookie);
    expect(door.status).toBe(200);
    const doorBody = await door.text();
    expect(doorBody).toContain("New agent");
  });
});

/**
 * The one function every page words a deployment's speed with. The pages
 * above prove it reaches the studio; these prove what it says at the edges,
 * where a real deploy is awkward to arrange.
 */
describe("servedPhrase", () => {
  const env = (extra: Partial<EnvStatus>): EnvStatus => ({
    env: "production",
    state: "running",
    commitOid: "cafebabe",
    url: "http://vault.apps.test",
    ...extra,
  });

  test("says nothing at all until the deployment serves", () => {
    expect(
      servedPhrase(
        env({
          createdAt: "2026-01-01T00:00:00.000Z",
          deployStartedAt: "2026-01-01T00:00:02.000Z",
        }),
      ),
    ).toBeUndefined();
  });

  test("clocks that disagree clamp to zero rather than printing a negative", () => {
    expect(
      servedPhrase(
        env({
          createdAt: "2026-01-01T00:00:00.300Z",
          deployStartedAt: "2026-01-01T00:00:00.300Z",
          servingAt: "2026-01-01T00:00:00.000Z",
        }),
      ),
    ).toBe("0.0s after the push");
    // A start before the push it answers is skew too: no negative wait.
    expect(
      servedPhrase(
        env({
          createdAt: "2026-01-01T00:00:05.000Z",
          deployStartedAt: "2026-01-01T00:00:00.000Z",
          servingAt: "2026-01-01T00:00:06.000Z",
        }),
      ),
    ).toBe("1.0s after the push");
  });

  test("a wait under a second is noise: the phrase reads as it always has", () => {
    expect(
      servedPhrase(
        env({
          createdAt: "2026-01-01T00:00:00.000Z",
          deployStartedAt: "2026-01-01T00:00:00.900Z",
          servingAt: "2026-01-01T00:00:04.300Z",
        }),
      ),
    ).toBe("4.3s after the push");
  });

  test("a push with no start recorded is still measured from the push", () => {
    expect(
      servedPhrase(
        env({
          createdAt: "2026-01-01T00:00:00.000Z",
          servingAt: "2026-01-01T00:00:02.500Z",
        }),
      ),
    ).toBe("2.5s after the push");
  });

  test("a deployment with neither instant, and an unreadable one, say nothing", () => {
    expect(
      servedPhrase(env({ servingAt: "2026-01-01T00:00:02.500Z" })),
    ).toBeUndefined();
    expect(
      servedPhrase(
        env({ createdAt: "not a time", servingAt: "2026-01-01T00:00:02.500Z" }),
      ),
    ).toBeUndefined();
  });
});

describe("previewLatency: the median seconds from push to serving", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let repo: Repo;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-preview-latency-"));
    app = createApp({ dataDir, port: 0 });
    const a = await createUser(app.db, { trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createRepo(app, alice, {
      name: "latency",
      visibility: "private",
      description: "",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** A deploy run stamped with a known push instant and, unless null, known started/serving instants. */
  const seedDeploy = (
    createdAt: string,
    startedAt: string | null,
    servingAt: string | null,
  ): void => {
    const deploy = createRun(app.db, { repoId: repo.id, kind: "deploy" });
    app.db
      .query("UPDATE run SET created_at = ?2 WHERE id = ?1")
      .run(deploy.id, createdAt);
    if (startedAt !== null) {
      app.db
        .query("UPDATE run SET started_at = ?2 WHERE id = ?1")
        .run(deploy.id, startedAt);
    }
    if (servingAt !== null) {
      app.db
        .query("UPDATE run SET serving_at = ?2 WHERE id = ?1")
        .run(deploy.id, servingAt);
    }
  };

  test("no deploys, a never-served one, and the median of a growing set — all against one window", () => {
    const now = Date.now();
    const since = new Date(now - 60_000).toISOString();

    // Nothing seeded yet: undefined, never a zero.
    expect(previewLatency(app.db, repo.id, since)).toBeUndefined();

    // Before the window: a very slow deploy that must not pull the median up.
    seedDeploy(
      new Date(now - 10 * 24 * 60 * 60_000).toISOString(),
      null,
      new Date(now - 10 * 24 * 60 * 60_000 + 600_000).toISOString(),
    );
    expect(previewLatency(app.db, repo.id, since)).toBeUndefined();

    // A deploy that never served is left out, not counted as a zero.
    seedDeploy(new Date(now).toISOString(), null, null);
    expect(previewLatency(app.db, repo.id, since)).toBeUndefined();

    // Three served deploys, seeded out of order: an odd-count median.
    const durations = [2, 6, 4]; // seconds
    durations.forEach((d, i) => {
      const createdAt = new Date(now + i * 1_000).toISOString();
      seedDeploy(
        createdAt,
        null,
        new Date(Date.parse(createdAt) + d * 1_000).toISOString(),
      );
    });
    const odd = previewLatency(app.db, repo.id, since)!;
    expect(odd.n).toBe(3);
    expect(odd.medianSeconds).toBeCloseTo(4, 2);

    // A fourth deploy, 10s: the even-count median is the mean of the middle two.
    const createdAt = new Date(now + 3_000).toISOString();
    seedDeploy(
      createdAt,
      null,
      new Date(Date.parse(createdAt) + 10_000).toISOString(),
    );
    const even = previewLatency(app.db, repo.id, since)!;
    expect(even.n).toBe(4);
    expect(even.medianSeconds).toBeCloseTo(5, 2);

    // None of the above carried a `started_at`: the split has nothing to say.
    expect(even.queueMedianSeconds).toBeUndefined();
    expect(even.bootMedianSeconds).toBeUndefined();
    expect(even.splitN).toBe(0);
  });

  test("the split between waiting to be picked up and coming up, seeded beside a total", () => {
    const now = Date.now() + 10_000_000; // clear of the previous test's window
    const since = new Date(now - 60_000).toISOString();

    // Three deploys with known queue and boot segments: (queue, boot) in seconds.
    const segments: readonly (readonly [number, number])[] = [
      [1, 3],
      [2, 6],
      [3, 9],
    ];
    segments.forEach(([queue, boot], i) => {
      const createdAt = now + i * 1_000;
      const startedAt = createdAt + queue * 1_000;
      const servingAt = startedAt + boot * 1_000;
      seedDeploy(
        new Date(createdAt).toISOString(),
        new Date(startedAt).toISOString(),
        new Date(servingAt).toISOString(),
      );
    });
    const full = previewLatency(app.db, repo.id, since)!;
    expect(full.n).toBe(3);
    expect(full.splitN).toBe(3);
    expect(full.queueMedianSeconds).toBeCloseTo(2, 2);
    expect(full.bootMedianSeconds).toBeCloseTo(6, 2);

    // A fourth, served deploy with no `started_at`: it feeds the total but
    // is left out of the split, never counted as a zero-length queue or boot.
    const createdAt = now + 3_000;
    seedDeploy(
      new Date(createdAt).toISOString(),
      null,
      new Date(createdAt + 100_000).toISOString(),
    );
    const withGap = previewLatency(app.db, repo.id, since)!;
    expect(withGap.n).toBe(4);
    expect(withGap.splitN).toBe(3);
    expect(withGap.queueMedianSeconds).toBeCloseTo(2, 2);
    expect(withGap.bootMedianSeconds).toBeCloseTo(6, 2);
  });

  test("a deploy that finished without ever serving is counted apart, never in the median; one still running is counted as neither", () => {
    const now = Date.now() + 20_000_000; // clear of the earlier tests' windows
    const since = new Date(now - 60_000).toISOString();

    // Two served deploys, 4s and 6s.
    [4, 6].forEach((d, i) => {
      const createdAt = new Date(now + i * 1_000).toISOString();
      seedDeploy(
        createdAt,
        null,
        new Date(Date.parse(createdAt) + d * 1_000).toISOString(),
      );
    });
    const clean = previewLatency(app.db, repo.id, since)!;
    expect(clean.n).toBe(2);
    expect(clean.failedN).toBe(0);
    expect(clean.medianSeconds).toBeCloseTo(5, 2);

    // A deploy still queued: neither served nor finished. Moves neither number.
    const inFlight = createRun(app.db, { repoId: repo.id, kind: "deploy" });
    app.db
      .query("UPDATE run SET created_at = ?2 WHERE id = ?1")
      .run(inFlight.id, new Date(now + 2_000).toISOString());
    const withInFlight = previewLatency(app.db, repo.id, since)!;
    expect(withInFlight.n).toBe(2);
    expect(withInFlight.failedN).toBe(0);
    expect(withInFlight.medianSeconds).toBeCloseTo(5, 2);

    // A deploy that finished but never served — counted as failed, never a
    // zero-second deploy pulling the median down.
    const failed = createRun(app.db, { repoId: repo.id, kind: "deploy" });
    app.db
      .query("UPDATE run SET created_at = ?2 WHERE id = ?1")
      .run(failed.id, new Date(now + 3_000).toISOString());
    claimRun(app.db, failed.id);
    finishRun(app.db, failed.id, { state: "failed", summary: "build failed" });
    const withFailed = previewLatency(app.db, repo.id, since)!;
    expect(withFailed.n).toBe(2);
    expect(withFailed.failedN).toBe(1);
    expect(withFailed.medianSeconds).toBeCloseTo(5, 2);

    // A cancelled deploy that never served also counts as failed.
    const cancelled = createRun(app.db, { repoId: repo.id, kind: "deploy" });
    app.db
      .query("UPDATE run SET created_at = ?2 WHERE id = ?1")
      .run(cancelled.id, new Date(now + 4_000).toISOString());
    claimRun(app.db, cancelled.id);
    app.db
      .query(
        "UPDATE run SET state = 'cancelled', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
      )
      .run(cancelled.id);
    const withCancelled = previewLatency(app.db, repo.id, since)!;
    expect(withCancelled.n).toBe(2);
    expect(withCancelled.failedN).toBe(2);
    expect(withCancelled.medianSeconds).toBeCloseTo(5, 2);
  });

  test("a week with only never-served deploys still reports the failed count, with no median to give", () => {
    const now = Date.now() + 30_000_000;
    const since = new Date(now - 60_000).toISOString();

    const failed = createRun(app.db, { repoId: repo.id, kind: "deploy" });
    app.db
      .query("UPDATE run SET created_at = ?2 WHERE id = ?1")
      .run(failed.id, new Date(now).toISOString());
    claimRun(app.db, failed.id);
    finishRun(app.db, failed.id, { state: "failed", summary: "build failed" });

    const latency = previewLatency(app.db, repo.id, since)!;
    expect(latency).toBeDefined();
    expect(latency.n).toBe(0);
    expect(latency.failedN).toBe(1);
    expect(latency.medianSeconds).toBeUndefined();
  });

  test("a deploy the forge's own restart cancelled is never counted as failed, nor in the total it is 'of' (#255, #274)", () => {
    const now = Date.now() + 40_000_000;
    const since = new Date(now - 60_000).toISOString();

    // A real failure: counted.
    const failed = createRun(app.db, { repoId: repo.id, kind: "deploy" });
    app.db
      .query("UPDATE run SET created_at = ?2 WHERE id = ?1")
      .run(failed.id, new Date(now).toISOString());
    claimRun(app.db, failed.id);
    finishRun(app.db, failed.id, { state: "failed", summary: "build failed" });

    // A deploy the forge's own restart cancelled: not this commit's fault,
    // and not counted at all — neither as a failure nor in the total.
    const stopped = createRun(app.db, { repoId: repo.id, kind: "deploy" });
    app.db
      .query("UPDATE run SET created_at = ?2 WHERE id = ?1")
      .run(stopped.id, new Date(now + 1_000).toISOString());
    claimRun(app.db, stopped.id);
    app.db
      .query(
        "UPDATE run SET state = 'cancelled', summary = ?2, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
      )
      .run(stopped.id, STOPPED_SUMMARY);

    const latency = previewLatency(app.db, repo.id, since)!;
    expect(latency.n).toBe(0);
    expect(latency.failedN).toBe(1);

    // A person's own Cancel, carrying a different summary, still counts —
    // only the forge's own reason is left out.
    const byPerson = createRun(app.db, { repoId: repo.id, kind: "deploy" });
    app.db
      .query("UPDATE run SET created_at = ?2 WHERE id = ?1")
      .run(byPerson.id, new Date(now + 2_000).toISOString());
    claimRun(app.db, byPerson.id);
    app.db
      .query(
        "UPDATE run SET state = 'cancelled', summary = 'cancelled by alice', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
      )
      .run(byPerson.id);
    const withPerson = previewLatency(app.db, repo.id, since)!;
    expect(withPerson.failedN).toBe(2);
  });
});

describe("the studio's own words for how fast a change reaches its preview", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let repo: Repo;
  let ownerCookie: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-preview-latency-page-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, { trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    ownerCookie = (
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
      name: "trickle",
      visibility: "private",
      description: "",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "start\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, alice, repo, { slug: "trickle" });
    if (!enabled.ok) throw new Error(String(enabled.error));
    // Enough history behind it that these tests exercise the preview
    // wording, not the day-one line (#274) — a finished agent run from
    // well outside this week's own window.
    const seedRun = createRun(app.db, { repoId: repo.id, kind: "agent" });
    app.db
      .query("UPDATE run SET created_at = ?2 WHERE id = ?1")
      .run(
        seedRun.id,
        new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString(),
      );
    claimRun(app.db, seedRun.id);
    finishRun(app.db, seedRun.id, { state: "ok", summary: "seed" });
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const get = (path: string) =>
    fetch(`${base}${path}`, {
      headers: { cookie: `${ownerCookie}; forge_mode=studio` },
      redirect: "manual",
    });

  test("fewer than three served deploys this week says so plainly rather than a median of one", async () => {
    const before = await (await get("/alice/trickle")).text();
    expect(before).toContain("not enough deploys this week to say");
    expect(before).not.toContain("reaches its preview in");

    const deploy = createRun(app.db, {
      repoId: repo.id,
      kind: "deploy",
      env: "production",
      reason: "push",
    });
    markServing(app.db, deploy.id);
    const one = await (await get("/alice/trickle")).text();
    expect(one).toContain("not enough deploys this week to say");
    expect(one).not.toContain("reaches its preview in");
  });

  test("the split reads as the total's explanation, and says when it is drawn from fewer deploys", async () => {
    const seedDeploy = (
      createdAt: string,
      startedAt: string | null,
      servingAt: string,
    ): void => {
      const deploy = createRun(app.db, { repoId: repo.id, kind: "deploy" });
      app.db
        .query("UPDATE run SET created_at = ?2 WHERE id = ?1")
        .run(deploy.id, createdAt);
      if (startedAt !== null) {
        app.db
          .query("UPDATE run SET started_at = ?2 WHERE id = ?1")
          .run(deploy.id, startedAt);
      }
      app.db
        .query("UPDATE run SET serving_at = ?2 WHERE id = ?1")
        .run(deploy.id, servingAt);
    };
    // Three deploys with a known queue and boot each.
    const now = Date.now();
    const segments: readonly (readonly [number, number])[] = [
      [1, 3],
      [2, 6],
      [3, 9],
    ];
    segments.forEach(([queue, boot], i) => {
      const createdAt = now + i * 1_000;
      const startedAt = createdAt + queue * 1_000;
      const servingAt = startedAt + boot * 1_000;
      seedDeploy(
        new Date(createdAt).toISOString(),
        new Date(startedAt).toISOString(),
        new Date(servingAt).toISOString(),
      );
    });
    // A fourth, served deploy with no `started_at`: it feeds the total but
    // is left out of the split.
    seedDeploy(
      new Date(now + 3_000).toISOString(),
      null,
      new Date(now + 100_000).toISOString(),
    );
    const page = await (await get("/alice/trickle")).text();
    expect(page).toContain("4 deploys");
    expect(page).toContain("2.0s waiting");
    // Only 3 of the 4 served deploys carried a `started_at`: the split says so.
    expect(page).toContain("6.0s coming up (3 of 4)");

    // A clean week — every deploy served — reads exactly as it always has:
    // no mention of failures, no empty clause left dangling.
    expect(page).not.toContain("never reached a preview");
    expect(page).not.toContain("0 failed");
  });

  test("a deploy that finished without ever serving is counted and worded, and links to the runs list", async () => {
    const before = await (await get("/alice/trickle")).text();

    const failed = createRun(app.db, {
      repoId: repo.id,
      kind: "deploy",
      env: "production",
      reason: "push",
    });
    claimRun(app.db, failed.id);
    finishRun(app.db, failed.id, { state: "failed", summary: "build failed" });

    const after = await (await get("/alice/trickle")).text();
    expect(after).toContain("1 of 5 never reached a preview");
    expect(after).toContain(`href="/alice/trickle/runs?kind=deploy"`);

    // A deploy still running moves neither the served count nor the failed
    // count: it is neither served nor finished.
    const inFlight = createRun(app.db, {
      repoId: repo.id,
      kind: "deploy",
      env: "production",
      reason: "push",
    });
    claimRun(app.db, inFlight.id);
    const withInFlight = await (await get("/alice/trickle")).text();
    expect(withInFlight).toContain("1 of 5 never reached a preview");
    expect(withInFlight).not.toBe(before);
  });
});

describe("a low deploy count never reads as a failure ratio (#274)", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let repo: Repo;
  let ownerCookie: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-low-count-ratio-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, { trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    ownerCookie = (
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
      name: "tworuns",
      visibility: "private",
      description: "",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "start\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, alice, repo, { slug: "tworuns" });
    if (!enabled.ok) throw new Error(String(enabled.error));

    // History behind it, so the full panel renders — but only two deploys
    // this week, both never served, neither the forge's own doing.
    const seedRun = createRun(app.db, { repoId: repo.id, kind: "agent" });
    app.db
      .query("UPDATE run SET created_at = ?2 WHERE id = ?1")
      .run(
        seedRun.id,
        new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString(),
      );
    claimRun(app.db, seedRun.id);
    finishRun(app.db, seedRun.id, { state: "ok", summary: "seed" });

    for (let i = 0; i < 2; i++) {
      const failed = createRun(app.db, {
        repoId: repo.id,
        kind: "deploy",
        env: "production",
        reason: "push",
      });
      claimRun(app.db, failed.id);
      finishRun(app.db, failed.id, {
        state: "failed",
        summary: "build failed",
      });
    }
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const get = (path: string) =>
    fetch(`${base}${path}`, {
      headers: { cookie: `${ownerCookie}; forge_mode=studio` },
      redirect: "manual",
    });

  test("2 of 2 never reads as a ratio — a handful of deploys needs to be behind it first", async () => {
    const page = await (await get("/alice/tworuns")).text();
    expect(page).toContain("not enough deploys this week to say");
    expect(page).not.toContain("never reached a preview");
  });
});

describe("this week's runs and spend are counted by the database, not read off a page of runs", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let busy: Repo;
  let quiet: Repo;
  let ownerCookie: string;

  /** How many agent runs this week — more than `listRuns` would ever hand back. */
  const RUNS = 250;
  /** What each of them cost, in the float dollars the column holds. */
  const COST = 0.13;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-week-totals-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, { trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    ownerCookie = (
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

    for (const name of ["busy", "quiet"] as const) {
      const made = await createRepo(app, alice, {
        name,
        visibility: "private",
        description: "",
      });
      if (!made.ok) throw new Error(String(made.error));
      const seeded = await commitToBranch(app, alice, made.value, {
        message: "Start",
        files: [{ path: "README.md", content: "start\n" }],
      });
      if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
      const enabled = await enableApp(app, alice, made.value, { slug: name });
      if (!enabled.ok) throw new Error(String(enabled.error));
      if (name === "busy") busy = made.value;
      if (name === "quiet") quiet = made.value;
    }

    // A real week behind "quiet", just not this one — an old finished run,
    // so a week with nothing in it still reads as a quiet week (#274), not
    // as an app with no history at all.
    const oldQuiet = createRun(app.db, { repoId: quiet.id, kind: "agent" });
    claimRun(app.db, oldQuiet.id);
    finishRun(app.db, oldQuiet.id, { state: "ok", summary: "long ago" });
    app.db
      .query("UPDATE run SET created_at = ?2 WHERE id = ?1")
      .run(
        oldQuiet.id,
        new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString(),
      );

    const keeper = await createAgent(app, alice, { username: "keeper" });
    if (!keeper.ok) throw new Error(String(keeper.error));
    expect(addToCrew(app, alice, busy, "keeper").ok).toBe(true);
    const keeperId = getUserByName(app.db, "keeper")!.id;

    // 250 agent runs inside the week — past the 200 `listRuns` will return —
    // and one fat run ten days back that the window must leave out.
    for (let i = 0; i < RUNS; i++) {
      const r = createRun(app.db, {
        repoId: busy.id,
        kind: "agent",
        actorId: keeperId,
        reason: "assigned",
      });
      claimRun(app.db, r.id);
      finishRun(app.db, r.id, {
        state: "ok",
        summary: "did a thing",
        costUsd: COST,
      });
    }
    const old = createRun(app.db, {
      repoId: busy.id,
      kind: "agent",
      actorId: keeperId,
      reason: "assigned",
    });
    claimRun(app.db, old.id);
    finishRun(app.db, old.id, {
      state: "ok",
      summary: "last month",
      costUsd: 99,
    });
    app.db
      .query("UPDATE run SET created_at = ?2 WHERE id = ?1")
      .run(old.id, new Date(Date.now() - 10 * 24 * 60 * 60_000).toISOString());
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const get = (path: string) =>
    fetch(`${base}${path}`, {
      headers: { cookie: `${ownerCookie}; forge_mode=studio` },
      redirect: "manual",
    });

  test("the aggregate counts every run in the window, skips the one outside it, and is 0 for a week with none", () => {
    const week = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
    const totals = agentRunTotals(app.db, busy.id, week);
    expect(totals.runs).toBe(RUNS);
    expect(totals.spentUsd).toBeCloseTo(RUNS * COST, 6);

    // The whole ledger, window opened wide: the old run is there after all.
    const ever = agentRunTotals(app.db, busy.id, "2000-01-01T00:00:00.000Z");
    expect(ever.runs).toBe(RUNS + 1);
    expect(ever.spentUsd).toBeCloseTo(RUNS * COST + 99, 6);

    // SUM over no rows is NULL; a repository with no runs reads zero.
    const none = agentRunTotals(app.db, "no-such-repo", week);
    expect(none).toEqual({ runs: 0, spentUsd: 0 });
  });

  test("the app page says 250 runs and the sum of all 250, not the last 200", async () => {
    const page = await (await get("/alice/busy")).text();
    expect(page).toMatch(/Runs<\/dt>\s*<dd>250<\/dd>/);
    expect(page).toContain(`$${(RUNS * COST).toFixed(2)}`);
    // What the 200-row read would have said, and the run outside the window.
    expect(page).not.toContain(`$${(200 * COST).toFixed(2)}`);
    expect(page).not.toContain("$99.00");
  });

  test("an app with real history but no runs this week reads 0 and $0.00, never blank", async () => {
    const page = await (await get("/alice/quiet")).text();
    expect(page).toMatch(/Runs<\/dt>\s*<dd>0<\/dd>/);
    expect(page).toContain("$0.00");
  });
});

describe("this week's shipping is counted by the database, not read off a page of closed pulls", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let busy: Repo;
  let quiet: Repo;
  let ownerCookie: string;

  /** How many changes landed this week — past the page of closed pulls the
   * count used to be filtered out of. */
  const SHIPPED = 150;
  /** One agent run's cost, so the page prints a cost per shipped change. */
  const SPENT = 30;

  /** A pull row on a closed issue: `mergedAt` null is closed without a merge. */
  const seedPull = (repo: Repo, title: string, mergedAt: string | null) => {
    const opened = openIssue(app, alice, repo, { title });
    if (!opened.ok) throw new Error(String(opened.error));
    app.db
      .query(
        `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at)
         VALUES (?1, 'main', ?2, 'a', 'b', ?3)`,
      )
      .run(opened.value.id, `f${opened.value.number}`, mergedAt);
    app.db
      .query("UPDATE issue SET kind = 'pull', state = 'closed' WHERE id = ?1")
      .run(opened.value.id);
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-week-shipped-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, { trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    ownerCookie = (
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

    for (const name of ["busy", "quiet"] as const) {
      const made = await createRepo(app, alice, {
        name,
        visibility: "private",
        description: "",
      });
      if (!made.ok) throw new Error(String(made.error));
      const seeded = await commitToBranch(app, alice, made.value, {
        message: "Start",
        files: [{ path: "README.md", content: "start\n" }],
      });
      if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
      const enabled = await enableApp(app, alice, made.value, { slug: name });
      if (!enabled.ok) throw new Error(String(enabled.error));
      if (name === "busy") busy = made.value;
      if (name === "quiet") quiet = made.value;
    }

    // 150 changes landed inside the week — past the hundred closed pulls the
    // page used to read — plus two that must not count: one closed without a
    // merge, and one merged ten days back.
    const now = Date.now();
    for (let i = 0; i < SHIPPED; i++)
      seedPull(busy, `landed ${i}`, new Date(now - i * 60_000).toISOString());
    seedPull(busy, "abandoned", null);
    seedPull(
      busy,
      "landed last week",
      new Date(now - 10 * 24 * 60 * 60_000).toISOString(),
    );

    // A real week behind "quiet", just not this one — a change shipped a
    // month back, so a week with nothing new still reads as a quiet week
    // (#274), not as an app with no history at all.
    seedPull(
      quiet,
      "shipped a month ago",
      new Date(now - 30 * 24 * 60 * 60_000).toISOString(),
    );

    const keeper = await createAgent(app, alice, { username: "keeper" });
    if (!keeper.ok) throw new Error(String(keeper.error));
    expect(addToCrew(app, alice, busy, "keeper").ok).toBe(true);
    const run = createRun(app.db, {
      repoId: busy.id,
      kind: "agent",
      actorId: getUserByName(app.db, "keeper")!.id,
      reason: "assigned",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, {
      state: "ok",
      summary: "a week of work",
      costUsd: SPENT,
    });
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const get = (path: string) =>
    fetch(`${base}${path}`, {
      headers: { cookie: `${ownerCookie}; forge_mode=studio` },
      redirect: "manual",
    });

  test("the aggregate counts the merged pulls in the window and nothing else", () => {
    const week = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
    expect(mergedPullCount(app.db, busy.id, week)).toBe(SHIPPED);

    // Window opened wide: the older merge is there after all, the pull closed
    // without a merge still is not.
    expect(mergedPullCount(app.db, busy.id, "2000-01-01T00:00:00.000Z")).toBe(
      SHIPPED + 1,
    );

    // COUNT over no rows is 0, and another repo's merges are never this one's.
    expect(mergedPullCount(app.db, "no-such-repo", week)).toBe(0);
  });

  test("the app page says 150 changes shipped, not the 100 a page of closed pulls holds", async () => {
    const page = await (await get("/alice/busy")).text();
    expect(page).toMatch(/Shipped<\/dt>\s*<dd>150 changes<\/dd>/);
    expect(page).not.toContain("100 changes");
    // And the cost of a shipped change divides by all 150.
    expect(page).toContain(
      `$${(SPENT / SHIPPED).toFixed(2)} per shipped change`,
    );
  });

  test("an app with real history but nothing shipped this week reads 0 changes and no cost per change", async () => {
    const page = await (await get("/alice/quiet")).text();
    expect(page).toMatch(/Shipped<\/dt>\s*<dd>0 changes<\/dd>/);
    expect(page).not.toContain("per shipped change");
  });
});

describe("a one-minute-old app's front door does not lead with a week of zeros (#274)", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let repo: Repo;
  let ownerCookie: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-day-one-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, { trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    ownerCookie = (
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
      name: "newborn",
      visibility: "public",
      description: "",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "start\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, alice, repo, { slug: "newborn" });
    if (!enabled.ok) throw new Error(String(enabled.error));

    // Exactly the shape of a one-minute-old app: its own first two
    // production deploys, one of which the forge's own restart cancelled —
    // never a shipped change, never an agent run.
    const cancelledByForge = createRun(app.db, {
      repoId: repo.id,
      kind: "deploy",
      env: "production",
      reason: "boot",
    });
    claimRun(app.db, cancelledByForge.id);
    app.db
      .query(
        "UPDATE run SET state = 'cancelled', summary = ?2, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
      )
      .run(cancelledByForge.id, STOPPED_SUMMARY);
    const secondBoot = createRun(app.db, {
      repoId: repo.id,
      kind: "deploy",
      env: "production",
      reason: "push",
    });
    claimRun(app.db, secondBoot.id);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const get = (path: string) =>
    fetch(`${base}${path}`, {
      headers: { cookie: `${ownerCookie}; forge_mode=studio` },
      redirect: "manual",
    });

  test("the day-one page a person lands on from New app says one true line, not a week of zeros", async () => {
    const page = await (await get("/alice/newborn")).text();
    expect(page).toContain("This week");
    expect(page).toContain("Nothing to show yet");
    // Not a single zero from the old panel, and not the scary ratio: the
    // forge's own cancelled boot is never counted, and two deploys is well
    // under the threshold a ratio needs anyway.
    expect(page).not.toMatch(/Runs<\/dt>/);
    expect(page).not.toMatch(/Spent<\/dt>/);
    expect(page).not.toContain("never reached a preview");
    expect(page).not.toContain("$0.00");
  });

  test("a stranger sees the same quiet line, not the owner's zeros", async () => {
    const page = await (await fetch(`${base}/alice/newborn`)).text();
    expect(page).toContain("Nothing to show yet");
    expect(page).not.toMatch(/Shipped<\/dt>\s*<dd>0 changes<\/dd>/);
  });
});

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

    const a = await createUser(app.db, { trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
    });
    if (!a.ok) throw new Error(a.error);
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
    const bob = await createUser(app.db, { trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!bob.ok) throw new Error(bob.error);
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
    expect(html).toContain(`/alice/widgets/tells/${tellNumber}`);
    expect(html).toContain("Wire up the chess clock");
    expect(html).toContain(`/alice/widgets/changes/${changeNumber}`);
    expect(html).toContain("alice/widgets");
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

  test("?mode=dev on the same route still answers in dev's own words", async () => {
    const html = await (await asAlice("/search?q=chess&mode=dev")).text();
    expect(html).toContain("Repositories");
    expect(html).toContain("Issues and pull requests");
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

  test("the studio face leaves the code to dev, one link away, and ?mode=dev rides every link and the form", async () => {
    const studio = mainOf(await (await asAlice("/search?q=chess")).text());
    expect(studio).not.toContain('id="code"');
    expect(studio).toContain("/search?q=chess&amp;kind=code&amp;mode=dev");
    // A hand-written kind=code in the studio is its everything, not an error.
    const code = await asAlice("/search?q=chess&kind=code");
    expect(code.status).toBe(200);
    expect(mainOf(await code.text())).toContain('id="repos"');

    const dev = mainOf(await (await asAlice("/search?q=chess&mode=dev")).text());
    expect(dev).toContain('id="code"');
    expect(dev).toContain('name="mode" value="dev"');
    expect(dev).toContain("/search?q=chess&amp;kind=repos&amp;mode=dev");
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

  const home = (cookie: string) =>
    fetch(`${base}/`, {
      headers: { cookie: `${cookie}; forge_mode=studio` },
      redirect: "manual",
    }).then((r) => r.text());

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-studio-cost-today-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, { trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const c = await createUser(app.db, { trusted: true,
      username: "carol",
      email: "carol@forge.local",
      password: "a-good-passphrase",
    });
    if (!c.ok) throw new Error(c.error);
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
    expect(html).toMatch(/<a href="\/map">their ceiling<\/a>/);
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
    const a = await createUser(app.db, { trusted: true,
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
    expect(html).toMatch(/<h1 class="sr-only">Studio<\/h1>/);
  });

  test("the app page, the three lists, a tell, a change and a run each have one outline with no skipped level", async () => {
    const pages: Record<string, string> = {
      "the app page": "/alice/outline",
      "everything told": "/alice/outline/tells",
      "every change": "/alice/outline/changes",
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
    const a = await createUser(app.db, { trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
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
    expect(serving).toContain("serving");
    expect(serving).toContain('action="/alice/notes/app/production/stop"');
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
    expect(html).not.toContain('action="/alice/notes/app/production/stop"');
  });

  test("pressed on a change's page, Stop comes back to that change", async () => {
    const stopped = await press(
      "stop",
      "studio",
      `${base}/alice/notes/changes/1`,
    );
    expect(stopped.status).toBe(303);
    expect(stopped.headers.get("location")).toBe("/alice/notes/changes/1");
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
    expect(owner).toContain(`action="/alice/notes/app/${env}/stop"`);
    expect(owner).toContain(`href="/alice/notes/app/${env}/open"`);
    expect(owner).toContain('href="/alice/notes/settings/app"');

    const stranger = await (
      await fetch(`${base}/alice/notes`, { redirect: "manual" })
    ).text();
    expect(stranger).toContain(`href="/alice/notes/app/${env}/open"`);
    expect(stranger).not.toContain("/redeploy");
    expect(stranger).not.toContain("/stop");
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
    const a = await createUser(app.db, { trusted: true,
      username: "ivy",
      email: "ivy@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
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
    const changes = await anon("/ivy/pub/changes");
    const change = await anon(`/ivy/pub/changes/${personPull.number}`);

    const onApp = rowWith(appPage, `/changes/${personPull.number}`);
    const onList = rowWith(changes, `/changes/${personPull.number}`);
    expect(onApp).toContain("ivy");
    expect(onApp).not.toContain("the crew");
    // The same name the list gives, and the same initials beside it.
    expect(initialsIn(onApp)).toBe(initialsIn(onList));
    expect(initialsIn(onApp)).toBe("i");
    expect(change).toContain("ivy");

    // A tell she took herself is hers on the same panel, by the same rule.
    const held = rowWith(appPage, `/tells/${heldTell.number}`);
    expect(held).toContain("ivy");
    expect(held).not.toContain("the crew");
    expect(initialsIn(held)).toBe("i");
  });

  test("the crew's own change and the crew's own run still read as the crew's to that visitor", async () => {
    const appPage = await anon("/ivy/pub");
    const onApp = rowWith(appPage, `/changes/${agentPull.number}`);
    expect(onApp).toContain("the crew");
    expect(onApp).not.toContain("quill");
    expect(initialsIn(onApp)).toBe("tc");

    const runRow = rowWith(appPage, `/runs/${agentRun.id}`);
    expect(runRow).toContain("the crew");
    expect(runRow).not.toContain("quill");

    const tellRow = rowWith(appPage, `/tells/${waitingTell.number}`);
    expect(tellRow).toContain("the crew");
    expect(tellRow).not.toContain("quill");

    // Nothing the owner keeps to herself came along with the name.
    expect(appPage).not.toContain("quill");
    expect(appPage).not.toMatch(/\$\d/);
    expect(appPage).not.toContain(">Crew<");
  });

  test("the owner still reads the crew by name, and her own change as her own", async () => {
    const appPage = await owner("/ivy/pub");
    expect(rowWith(appPage, `/changes/${agentPull.number}`)).toContain("quill");
    expect(rowWith(appPage, `/runs/${agentRun.id}`)).toContain("quill");
    expect(rowWith(appPage, `/changes/${personPull.number}`)).toContain("ivy");
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
    const a = await createUser(app.db, { trusted: true,
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
  });

  afterAll(async () => {
    servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a repository with nothing in it says what to do, and blames no filter", async () => {
    await setup("blank");
    for (const [path, words] of [
      ["issues", "Tell the crew what you want"],
      ["pulls", "A change is the crew"],
      ["runs", "A run is one go"],
    ] as const) {
      const page = await get(`/alice/blank/${path}`);
      expect(page).toContain("Nothing here");
      expect(page).toContain(words);
      expect(page).not.toContain("this filter");
    }
  });

  test("a filter that hides every row is named", async () => {
    const repo = await setup("busy");
    const told = openIssue(app, alice, repo, { title: "Add a tab", body: "" });
    if (!told.ok) throw new Error(String(told.error));
    const issues = await get("/alice/busy/issues?word=shipped");
    expect(issues).toContain("Nothing told is shipped yet.");
    expect(issues).not.toContain("Tell the crew what you want");
    const pulls = await get("/alice/busy/pulls?word=look");
    expect(pulls).toContain("No change is look yet.");
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
    const alice = await createUser(app.db, { trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!alice.ok) throw new Error(alice.error);
    const carol = await createUser(app.db, { trusted: true,
      username: "carol",
      email: "carol@forge.local",
      password: "a-good-passphrase",
    });
    if (!carol.ok) throw new Error(carol.error);
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
    // The rendered form carries the branch-protection fields it never shows
    // as hidden inputs, so a real submit of it — exactly what's posted here
    // — cannot silently turn them off.
    const before = await (
      await get("/alice/lamp/settings", ownerCookie)
    ).text();
    expect(before).toContain('<input type="hidden" name="protect" value="on"');
    expect(before).toContain(
      '<input type="hidden" name="requireReview" value="on"',
    );
    expect(before).toContain(
      '<input type="hidden" name="requireChecks" value="on"',
    );

    const saved = await post(
      "/alice/lamp/settings",
      {
        description: "a lamp that stays lit all night",
        visibility: "private",
        protect: "on",
        requireReview: "on",
        requireChecks: "on",
      },
      ownerCookie,
    );
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe("/alice/lamp/settings");

    const ownPage = await (
      await get("/alice/lamp?mode=dev", ownerCookie)
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

    const shelf = await (await get("/", ownerCookie)).text();
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
