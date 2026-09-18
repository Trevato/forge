/**
 * One mechanical check for every studio page: none of dev's vocabulary
 * leaks onto it, the security floor's headers are still on it, the studio
 * chrome is, and it stays small enough that a diff could never hide inside
 * it. `docs/STUDIO.md`'s five words are each one thing in git; this is the
 * test that nothing else says the git word instead.
 *
 * To register a new studio page for this check: add one row to `pages`
 * (built in the test below, once the fixture that gives it something real
 * to show exists) with the studio word it speaks and the path to fetch.
 * Nothing else in this file changes — the same forbidden-vocabulary,
 * chrome, header and size assertions walk it too. A route not yet wired
 * into the router (`http/server.ts`) answers 404 and is skipped rather
 * than failed, so a row for a page still being built does not block this
 * file from landing first.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { enableApp } from "../src/actions/apps.ts";
import { previewEnv, type EnvName } from "../src/apps/data.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { getAppByRepo, type AppRecord } from "../src/core/apps.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

/**
 * Dev's own words, each with the reason it must never reach a studio page.
 * Checked with every `<script>` stripped first: the shared client script
 * (`shellJs`, `src/web/client.ts`) ships on every page and classifies a raw
 * agent log line by matching literal text like "branch " and "committed
 * the", so its source would otherwise trip this file's own checks on pages
 * that never rendered a word of it.
 */
const DEV_WORDS: readonly { pattern: RegExp; because: string }[] = [
  {
    pattern: /diff-table/,
    because: "a change is judged by what it does, never its diff",
  },
  {
    pattern: /class="label lc-/,
    because: "a label chip is dev's own sorting, not one of the five words",
  },
  {
    pattern: /opened by/i,
    because: "the studio says who made a change in its own words",
  },
  {
    pattern: /checks (passed|failed)/i,
    because: "a check reads as one of the five words, not dev's pass/fail",
  },
  {
    pattern: /\brepository\b/i,
    because: "the studio calls it an app",
  },
  {
    pattern: /\bcommit\b/i,
    because: "a short sha in a caption is fine; the word never is",
  },
  {
    pattern: /\bbranch\b/i,
    because: "a change is judged by what it does, not where it lives",
  },
  {
    pattern: /\bmerge\b/i,
    because: "the studio's own word for a merge is shipped",
  },
];

/**
 * What a page itself says, in words a person reads — `<main id="main">`,
 * `page()`'s own (`src/web/layout.ts`), not the one sitewide shell around
 * every page in both faces on purpose: the topbar (mode switch, the "New
 * repository" item beside "New app" in the "+" menu, search) and the
 * footer. A hover title, an aria-label ("Where this repository is read
 * from", on the mirror pin every repository carries) or an href (the deep
 * link to dev's own commit view under a short sha, `?mode=dev` itself) is
 * a destination or a hint for a screen reader, not a word the page said
 * out loud — the risk this file's own header warns about, a short sha in
 * a caption is fine and the link it sits on is how the studio keeps dev
 * one click away.
 */
const pageContent = (html: string): string =>
  (html.match(/<main[^>]*id="main"[\s\S]*?<\/main>/)?.[0] ?? html)
    .replace(/\s(?:aria-label|title|placeholder|href)="[^"]*"/g, "")
    // The pull/issue state badge (`stateBadge`, "Merged") and the
    // conversation's own "merged this" history line (`stateEvents`,
    // `src/web/pages/thread.ts`) are the one thread dev's page reads too —
    // docs/STUDIO.md says so explicitly ("the conversation: read it, add
    // to it"). The studio's own word for the state is `wordBadge`
    // elsewhere on the page (`data-word="shipped"`), checked below; these
    // are the shared history underneath it, not a word the studio page
    // itself chose to say.
    .replace(/data-pr="merged"[\s\S]*?Merged<\/span/, 'data-pr="merged">…</span')
    .replace(/<span>merged this<\/span>/, "<span>…</span>")
    // Every icon (`icon()`, `src/web/icons.ts`) is a decorative, aria-hidden
    // svg named after a Lucide glyph — `ico-merge` is a shape, not a word,
    // and it rides on things dev and studio share alike (a timeline dot).
    .replace(/<svg[\s\S]*?<\/svg>/g, "");

/** Generous next to a real page (tens of KB); nowhere near the 2.5 MB one
 * file diff cost the studio pull page before it had its own render. */
const MAX_BODY_BYTES = 300_000;

describe("dev's vocabulary never reaches a studio page", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let base: string;
  let cookie: string;
  let record: AppRecord;
  let tellNumber: number;
  let runId: string;
  let openPullNumber: number;
  let mergedPullNumber: number;
  let openBranch: string;
  let mergedBranch: string;

  interface EnvSlot {
    readonly app: AppRecord;
    readonly env: EnvName;
    readonly chain: Promise<void>;
    readonly restarts: number[];
    live?: unknown;
  }
  const putLive = (env: EnvName, live: unknown): void => {
    (runtime as unknown as { envs: Map<string, EnvSlot> }).envs.set(
      `${record.id}/${env}`,
      { app: record, env, chain: Promise.resolve(), restarts: [], live },
    );
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-studio-words-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    // No `.start()`: this test boots one forge and drives it through the
    // real actions, but the preview and production environments below are
    // injected directly, the way `test/studio.test.ts`'s own fragment tests
    // do, so nothing here waits on a real install or a real deploy.
    runtime = new AppsRuntime(app, {
      domain: "studio-words.test",
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 1,
    });

    const a = await createUser(app.db, {
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
      name: "vocab",
      visibility: "private",
      description: "a place to catch dev's words",
    });
    if (!made.ok) throw new Error(String(made.error));
    const repo = made.value;
    const seeded = await commitToBranch(app, a.value, repo, {
      message: "Start",
      files: [
        {
          path: "package.json",
          content: '{"name":"vocab","scripts":{"start":"bun run server.ts"}}\n',
        },
        {
          path: "server.ts",
          content:
            "Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('ok') });\n",
        },
      ],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, a.value, repo, { slug: "vocab" });
    if (!enabled.ok) throw new Error(String(enabled.error));
    record = getAppByRepo(app.db, repo.id)!;

    const scout = await createAgent(app, a.value, { username: "scout" });
    if (!scout.ok) throw new Error(String(scout.error));
    expect(addToCrew(app, a.value, repo, "scout").ok).toBe(true);
    const scoutUser = getUserByName(app.db, "scout")!;

    // A tell, assigned, with a run — the studio's *tell* and *working*.
    const told = openIssue(app, a.value, repo, {
      title: "Make the export button work",
      body: "It does nothing right now.",
    });
    if (!told.ok) throw new Error(String(told.error));
    tellNumber = told.value.number;
    expect(assignIssue(app, a.value, repo, told.value, scoutUser).ok).toBe(
      true,
    );
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: told.value.id,
      actorId: scoutUser.id,
      reason: "assigned",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, {
      state: "ok",
      summary: "Wired up the export handler.",
      costUsd: 0.34,
      turns: 6,
    });
    runId = run.id;

    // An open pull with a green check and a preview — the studio's *look*.
    openBranch = "add-export";
    const openBranchMade = await commitToBranch(app, a.value, repo, {
      branch: openBranch,
      base: repo.defaultBranch,
      message: "Add export",
      files: [{ path: "export.ts", content: "export {};\n" }],
    });
    if (!openBranchMade.ok) throw new Error(JSON.stringify(openBranchMade.error));
    const opened = await openPull(app, scoutUser, repo, {
      title: "Add the export button",
      body: `Closes #${tellNumber}.`,
      baseBranch: repo.defaultBranch,
      headBranch: openBranch,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    openPullNumber = opened.value.number;
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
    putLive(previewEnv(opened.value.number), {
      commitOid: opened.value.headOid,
      handle: { port: 4321 },
      runId: check.id,
      since: new Date().toISOString(),
      manifest: { tty: null },
    });

    // A merged change, production caught up to it — the studio's *shipped*.
    mergedBranch = "faster-notes";
    const mergedBranchMade = await commitToBranch(app, a.value, repo, {
      branch: mergedBranch,
      base: repo.defaultBranch,
      message: "Faster",
      files: [{ path: "FAST.md", content: "fast\n" }],
    });
    if (!mergedBranchMade.ok)
      throw new Error(JSON.stringify(mergedBranchMade.error));
    const toMerge = await openPull(app, a.value, repo, {
      title: "Make the notes page faster",
      body: "",
      baseBranch: repo.defaultBranch,
      headBranch: mergedBranch,
    });
    if (!toMerge.ok) throw new Error(String(toMerge.error));
    mergedPullNumber = toMerge.value.number;
    const mergedCheck = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: toMerge.value.id,
      env: `pull-${toMerge.value.number}`,
      commitOid: toMerge.value.headOid,
      reason: "pull",
    });
    claimRun(app.db, mergedCheck.id);
    finishRun(app.db, mergedCheck.id, {
      state: "ok",
      summary: "check passed in 1s",
    });
    const merged = await mergePull(app, a.value, repo, toMerge.value, "squash");
    if (!merged.ok) throw new Error(String(merged.error));
    const mergedOid = merged.value.mergeOid;
    const deploy = createRun(app.db, {
      repoId: repo.id,
      kind: "deploy",
      env: "production",
      commitOid: mergedOid,
      reason: "push",
    });
    claimRun(app.db, deploy.id);
    finishRun(app.db, deploy.id, { state: "ok", summary: "deploy" });
    putLive("production", {
      commitOid: mergedOid,
      handle: { port: 4321 },
      runId: deploy.id,
      since: new Date().toISOString(),
      manifest: { tty: null },
    });
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("home, app, tell, working, look and shipped: no dev word, the studio chrome, the security floor, and a page a diff would never fit in", async () => {
    const pages: { word: string; path: string }[] = [
      { word: "home", path: "/" },
      { word: "app", path: "/alice/vocab" },
      { word: "tell", path: `/alice/vocab/issues/${tellNumber}` },
      { word: "working", path: `/alice/vocab/runs/${runId}` },
      { word: "look", path: `/alice/vocab/pulls/${openPullNumber}` },
      { word: "shipped", path: `/alice/vocab/pulls/${mergedPullNumber}` },
    ];

    for (const p of pages) {
      const res = await fetch(`${base}${p.path}`, {
        headers: { cookie: `${cookie}; forge_mode=studio` },
        redirect: "manual",
      });
      // A route not yet wired into the router answers 404 — skip it rather
      // than fail, so a row for a page still being built (docs/STUDIO.md's
      // lists, as they land) does not block this file.
      if (res.status === 404) continue;
      expect(res.status).toBe(200);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("same-origin");
      expect(res.headers.get("content-security-policy")).toContain(
        "default-src 'none'",
      );

      const html = await res.text();
      expect(
        html.length,
        `${p.word} (${p.path}) is ${html.length} bytes — a diff would blow through ${MAX_BODY_BYTES}`,
      ).toBeLessThan(MAX_BODY_BYTES);
      // The studio chrome: the topbar's own tab reads "Studio", never
      // "Code", the moment the mode and the repository are the studio's —
      // and it is the only source of the literal word on any of these
      // pages, so its presence here is the chrome, proven.
      expect(html).toContain("Studio");

      const visible = pageContent(html);
      for (const { pattern, because } of DEV_WORDS) {
        expect(
          visible,
          `${p.word} (${p.path}) said dev's word ${pattern} — ${because}`,
        ).not.toMatch(pattern);
      }
      expect(
        visible,
        `${p.word} (${p.path}) named the open branch "${openBranch}"`,
      ).not.toContain(openBranch);
      expect(
        visible,
        `${p.word} (${p.path}) named the merged branch "${mergedBranch}"`,
      ).not.toContain(mergedBranch);
    }

    // A run id is a key, not a headline: it rides hrefs (the dev link, the
    // steer form) but never becomes the page's own title.
    const transcript = await (
      await fetch(`${base}/alice/vocab/runs/${runId}`, {
        headers: { cookie: `${cookie}; forge_mode=studio` },
        redirect: "manual",
      })
    ).text();
    const title = transcript.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "";
    const h1 = transcript.match(/<h1>([\s\S]*?)<\/h1>/)?.[1] ?? "";
    expect(title).not.toContain(runId);
    expect(h1).not.toContain(runId);
  });

  test("?mode=dev on the same routes still carries dev's own words — the assertions above are real, not vacuous", async () => {
    const dev = await (
      await fetch(`${base}/alice/vocab/pulls/${openPullNumber}?mode=dev`, {
        headers: { cookie },
        redirect: "manual",
      })
    ).text();
    expect(dev).toContain("diff-table");
    expect(dev).toContain(openBranch);
  });
});
