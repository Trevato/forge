/**
 * One mechanical check for every studio page: none of dev's vocabulary
 * leaks onto it, the security floor's headers are still on it, the studio
 * chrome is, and it stays small enough that a diff could never hide inside
 * it. `docs/STUDIO.md`'s five words are each one thing in git; this is the
 * test that nothing else says the git word instead.
 *
 * To register a new studio page for this check: add one row to `pages`
 * (built at the end of `beforeAll`, once the fixture has given it something
 * real to show) with the studio word it speaks and the path to fetch.
 * Nothing else in this file changes — the same forbidden-vocabulary,
 * chrome, header and size assertions walk it, and so does the `?mode=dev`
 * test below, which is why a row carries the dev words the same path still
 * says in dev's own face. A row also names the `<title>` it answers with in
 * each face — the browser tab, the bookmark, the first thing a screen reader
 * announces (#262) — since `<head>` is outside `<main>` and nothing else
 * here would read it. The table is the one place a page is added, and
 * the proof it is not vacuous comes with it. Whatever a row needs to be
 * worth fetching — a second tell, a second change, a run that stopped, a
 * run still going — the one `beforeAll` seeds; there is no second seeding
 * helper, and no row is worth a page of setup of its own. A route not
 * yet wired into the router (`http/server.ts`) answers 404 and is skipped
 * rather than failed, so a row for a page still being built does not block
 * this file from landing first.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { enableApp } from "../src/actions/apps.ts";
import { previewEnv, type EnvName } from "../src/apps/data.ts";
import {
  AppsRuntime,
  NO_TESTS_TAIL,
  TESTS_PASSED_TAIL,
  type EnvStatus,
} from "../src/apps/runtime.ts";
import { getAppByRepo, type AppRecord } from "../src/core/apps.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { claimRun, createRun, finishRun, type Run } from "../src/core/runs.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { previewVerdict } from "../src/web/studio/previews.ts";
import { testsClause } from "../src/web/studio/words.ts";

/**
 * The nouns the studio once had for issues and pull requests (#3241: "i dont
 * like the told and changes"). Issues and pull requests are called that in
 * every mode, so none of these is said as a noun for one — in a nav tab, a
 * heading, a title, a list's empty state or a feed badge. "Tell the crew"
 * stays: it is a verb, the box a person types into. Checked against the
 * whole page's visible words, the repo header's tabs included.
 */
const RETIRED_NOUNS: readonly RegExp[] = [
  />\s*Told\s*</,
  />\s*Changes\s*</,
  /\bTells\b/,
  /\bEverything told\b/i,
  /\bNothing told\b/i,
  /\bEvery change\b/i,
  /\bClose (?:tell|change)\b/i,
  /\b(?:a|the|your|this|its|no) tells?\b/i,
  /\bTells? (?:&|and) changes\b/i,
  /<span class="badge"[^>]*>\s*(?:Change|Told)\s*<\/span>/,
];

/** The addresses the studio once gave them; none is linked to any more. */
const RETIRED_HREF = /href="\/[^"/]+\/[^"/]+\/(?:tells|changes)(?:[/?"])/;

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
  {
    pattern: /\bworkbench\b/i,
    because:
      "#281: a native app is the studio's alone, so its header draws no where strip at all",
  },
  {
    pattern: /this machine/i,
    because:
      "#281: dev's git chip (workbench · this machine) never reaches a studio header",
  },
  {
    // Scoped to a badge's own content — "failed" also rides inside the
    // legitimate `serving · tests failed` phrase (`envPhrase`), which does
    // not start a badge with the bare word. `stopped` is not here: it is
    // also a studio word in its own right, for a run the crew stopped on.
    pattern: /<span class="badge"[^>]*>\s*(?:failed|deploying)\s*<\/span>/,
    because:
      "envPhrase's word is the studio's word for production — 'not up' or 'starting', never the runtime's own EnvState (#201)",
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

/** The page's own title — `page()`'s `<title>`, without the sitewide
 * ` · forge` every page ends with. */
const titleOf = (html: string): string =>
  (html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "").replace(/ · forge$/, "");

/** Generous next to a real page (tens of KB); nowhere near the 2.5 MB one
 * file diff cost the studio pull page before it had its own render. */
const MAX_BODY_BYTES = 300_000;

/** One studio page this file walks: what to fetch, and what proves the
 * fetch was worth making. `shows`/`hides` are literal HTML, checked against
 * the whole response — they are about which rows landed on the page (a
 * `?word=` filter or a `cursor` page that narrowed nothing proves nothing),
 * never about vocabulary. `dev` is the other half: the words dev's own face
 * still says at the same path with `?mode=dev`, so a clean studio page can
 * never be clean merely because it rendered nothing. */
interface StudioPage {
  /** The studio word this page speaks — the label in a failure message. */
  readonly word: string;
  /** The path to fetch, `?word=` or `cursor=` and all. */
  readonly path: string;
  /** Literal HTML the studio's page must carry. */
  readonly shows?: readonly string[];
  /** Literal HTML it must not carry. */
  readonly hides?: readonly string[];
  /** Dev's own words the same path still says at `?mode=dev`, when dev has
   * a page of its own there. */
  readonly dev?: readonly string[];
  /** The whole `<title>` the studio's page answers with, ` · forge` aside. */
  readonly title?: string;
  /** The whole `<title>` dev's own page answers with at `?mode=dev`. */
  readonly devTitle?: string;
}

/** `?mode=dev` added to a path that may already carry a query. */
const asDev = (path: string): string =>
  `${path}${path.includes("?") ? "&" : "?"}mode=dev`;

describe("dev's vocabulary never reaches a studio page", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let base: string;
  let cookie: string;
  let record: AppRecord;
  let tellNumber: number;
  let tellTitle: string;
  let untouchedNumber: number;
  let untouchedTitle: string;
  let runId: string;
  let stoppedRunId: string;
  let workingRunId: string;
  let openPullNumber: number;
  let openPullTitle: string;
  let secondChangeNumber: number;
  let secondChangeTitle: string;
  let mergedPullNumber: number;
  let openBranch: string;
  let mergedBranch: string;
  let repoPath: string;
  /** Every branch this fixture made. No studio page names one of them. */
  const branches: string[] = [];
  /** The table every test below walks. Filled at the end of `beforeAll`. */
  let pages: readonly StudioPage[];

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

    const a = await createUser(app.db, { origin: "seed", trusted: true,
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

    // A tell nobody has picked up — the one row the issue list's own *told*
    // filter has to keep, since the tell below is claimed by a run and a
    // change before this fixture is done. Opened first, so its number is the
    // lower one and it is also what a `cursor` page of the list lands on.
    untouchedTitle = "List test: nobody has picked this up";
    const untouched = openIssue(app, a.value, repo, {
      title: untouchedTitle,
      body: "Still only said.",
    });
    if (!untouched.ok) throw new Error(String(untouched.error));
    untouchedNumber = untouched.value.number;

    // A tell, assigned, with a run — the studio's *tell* and *working*.
    tellTitle = "Make the export button work";
    const told = openIssue(app, a.value, repo, {
      title: tellTitle,
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
    branches.push(openBranch);
    const openBranchMade = await commitToBranch(app, a.value, repo, {
      branch: openBranch,
      base: repo.defaultBranch,
      message: "Add export",
      files: [{ path: "export.ts", content: "export {};\n" }],
    });
    if (!openBranchMade.ok) throw new Error(JSON.stringify(openBranchMade.error));
    openPullTitle = "Add the export button";
    const opened = await openPull(app, scoutUser, repo, {
      title: openPullTitle,
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
    branches.push(mergedBranch);
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

    // A second open change, nothing checked yet, and a run that stopped:
    // the rows a `?word=` filter and a `cursor` page of the two lists have
    // to leave behind for their narrowing to mean anything. Opened last, so
    // each is the newest of its list and the cursor that skips it is the
    // one a reader's own "next" link would carry.
    const secondBranch = "tidy-the-shelf";
    branches.push(secondBranch);
    const secondBranchMade = await commitToBranch(app, a.value, repo, {
      branch: secondBranch,
      base: repo.defaultBranch,
      message: "Tidy",
      files: [{ path: "TIDY.md", content: "tidy\n" }],
    });
    if (!secondBranchMade.ok)
      throw new Error(JSON.stringify(secondBranchMade.error));
    secondChangeTitle = "Tidy the shelf up";
    const second = await openPull(app, a.value, repo, {
      title: secondChangeTitle,
      body: "",
      baseBranch: repo.defaultBranch,
      headBranch: secondBranch,
    });
    if (!second.ok) throw new Error(String(second.error));
    secondChangeNumber = second.value.number;

    const stopped = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      actorId: scoutUser.id,
      reason: "assigned",
    });
    claimRun(app.db, stopped.id);
    finishRun(app.db, stopped.id, {
      state: "failed",
      summary: "stopped before it finished",
    });
    stoppedRunId = stopped.id;

    // A run still going, newest of the three: the row the `cursor` page of
    // the run list has to drop. Without it a cursor row would pass on the
    // word filter's work — the stopped run above is already off the bare
    // list — and prove nothing about paging at all.
    const working = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      actorId: scoutUser.id,
      reason: "assigned",
    });
    claimRun(app.db, working.id);
    workingRunId = working.id;

    // A second app with nothing told yet — the map's own empty state, what
    // a new app sees, which the crowded "vocab" repo above can never show.
    const blankRepo = await createRepo(app, a.value, {
      name: "blank",
      visibility: "private",
      description: "nothing asked yet",
    });
    if (!blankRepo.ok) throw new Error(String(blankRepo.error));
    const blankSeeded = await commitToBranch(app, a.value, blankRepo.value, {
      message: "Start",
      files: [
        {
          path: "package.json",
          content: '{"name":"blank","scripts":{"start":"bun run server.ts"}}\n',
        },
        {
          path: "server.ts",
          content:
            "Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('ok') });\n",
        },
      ],
    });
    if (!blankSeeded.ok) throw new Error(JSON.stringify(blankSeeded.error));
    const blankEnabled = await enableApp(app, a.value, blankRepo.value, {
      slug: "blank",
    });
    if (!blankEnabled.ok) throw new Error(String(blankEnabled.error));

    repoPath = "/alice/vocab";
    // Every studio page, one row each. A new studio page goes here — the
    // path it answers at, the word it speaks, and dev's own words at the
    // same path — and nothing else in this file changes.
    pages = [
      { word: "home", path: "/" },
      {
        // The repo header's tab strip (every studio page carries it): the
        // tab to the changes list names its own noun, never the five-word
        // "look" a green pull earns, and never that word's own eye icon —
        // both stay the picture card's and the word badge's alone (#172). The
        // tabs are words only since #8774, so the eye is simply absent.
        word: "app",
        path: repoPath,
        title: "vocab",
        shows: [">Issues", ">Pulls"],
        hides: [`#i-eye"/></svg>Look`, `>Look<`, 'class="where"'],
        // #630: the app page is the home in every mode; its code, with dev's
        // where strip, is the Files step one tab over.
      },
      {
        word: "tell",
        path: `${repoPath}/issues/${tellNumber}`,
        // #3241: an issue is closed with "Close issue" in every mode.
        shows: ["Close issue"],
        // One issue page (#626): dev's controls are its closed Details.
        title: `${tellTitle} · vocab`,
      },
      {
        word: "working",
        path: `${repoPath}/runs/${runId}`,
        title: `scout on #${tellNumber} ${tellTitle} · vocab`,
      },
      {
        word: "look",
        path: `${repoPath}/pulls/${openPullNumber}`,
        // #3241: a pull request is closed with "Close pull request".
        // One pull page (#628): the diff, the branch and the merge box are
        // its Files step, which speaks git on purpose, so it is not a row.
        shows: ["Close pull request", `${repoPath}/pulls/${openPullNumber}/files`],
        hides: ['class="where"'],
        title: `${openPullTitle} · vocab`,
      },
      {
        word: "shipped",
        path: `${repoPath}/pulls/${mergedPullNumber}`,
        shows: ['data-word="shipped"'],
      },
      {
        // #197: the map used to link every card to dev's `/issues/:number`
        // regardless of mode — the one studio page mode-blind about it.
        word: "map",
        path: `${repoPath}/map`,
        shows: [
          tellTitle,
          untouchedTitle,
          `href="${repoPath}/issues/${tellNumber}"`,
          `href="${repoPath}/issues/${untouchedNumber}"`,
        ],
      },
      {
        // The empty case: what a new app's map says before anything is told.
        word: "map (empty)",
        path: "/alice/blank/map",
        shows: ["No issues to map yet"],
      },
      // A word from the app's own description, not its name — the app's own
      // row coming back for it proves the search reaches the description,
      // not just a name match.
      { word: "search", path: "/search?q=catch", shows: [`href="${repoPath}"`] },
      // Everything told, every change, every run (#95): the three studio
      // lists, each as a person meets it — the bare list, the word filter
      // they click, and the `cursor` page their "next" link hands them.
      {
        word: "tells",
        path: `${repoPath}/issues`,
        shows: [untouchedTitle, tellTitle],
        // One list (#627), one noun (#3241).
        title: "Issues · vocab",
      },
      {
        word: "tells (told)",
        path: `${repoPath}/issues?word=told`,
        shows: [untouchedTitle],
        hides: [tellTitle],
      },
      {
        word: "tells (next page)",
        path: `${repoPath}/issues?cursor=${tellNumber}`,
        shows: [untouchedTitle],
        hides: [tellTitle],
      },
      {
        // #262: the one compose page; #3241: called a new issue in every
        // mode, and the form still posts where it always has.
        word: "new issue",
        path: `${repoPath}/issues/new`,
        shows: [`action="${repoPath}/issues/new"`, "<h1 class=\"mt\">New issue</h1>", "Create issue"],
        title: "New issue · vocab",
      },
      {
        word: "pulls",
        path: `${repoPath}/pulls`,
        shows: [openPullTitle, secondChangeTitle],
        title: "Pull requests · vocab",
      },
      {
        word: "changes (look)",
        path: `${repoPath}/pulls?word=look`,
        shows: [openPullTitle],
        hides: [secondChangeTitle],
      },
      {
        word: "changes (next page)",
        path: `${repoPath}/pulls?cursor=${secondChangeNumber}`,
        shows: [openPullTitle],
        hides: [secondChangeTitle],
      },
      {
        word: "runs",
        path: `${repoPath}/runs`,
        shows: [
          `href="${repoPath}/runs/${runId}"`,
          `href="${repoPath}/runs/${workingRunId}"`,
        ],
        // The stopped run is not open and moving, so the bare list leaves it
        // out — the filter below is where it shows up.
        hides: [`href="${repoPath}/runs/${stoppedRunId}"`],
        title: "Every run · vocab",
      },
      {
        word: "runs (stopped)",
        path: `${repoPath}/runs?word=stopped`,
        shows: [`href="${repoPath}/runs/${stoppedRunId}"`],
        hides: [
          `href="${repoPath}/runs/${runId}"`,
          `href="${repoPath}/runs/${workingRunId}"`,
        ],
      },
      {
        word: "runs (next page)",
        // Past the newest run, which is one the bare list would otherwise
        // show — so only the cursor can be what dropped it.
        path: `${repoPath}/runs?cursor=${workingRunId}`,
        shows: [`href="${repoPath}/runs/${runId}"`],
        hides: [`href="${repoPath}/runs/${workingRunId}"`],
      },
      // Settings (#631) is one page now: the studio's own cards lead it —
      // the crew, and how far it may go — and the branch, its gates and the
      // rest sit beneath in git's own words on purpose, so it is not a row
      // here; studio.test.ts holds its order.
    ];
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("every studio page — home, app, tell, working, look, shipped, search and the three lists: no dev word, the studio chrome, the security floor, and a page a diff would never fit in", async () => {
    for (const p of pages) {
      const res = await fetch(`${base}${p.path}`, {
        headers: { cookie: `${cookie}; forge_mode=studio` },
        redirect: "manual",
      });
      // A route not yet wired into the router answers 404 — skip it rather
      // than fail, so a row for a page still being built (docs/STUDIO.md's
      // lists, as they land) does not block this file. A row that names its
      // title is a finished page, and never skipped.
      if (res.status === 404 && p.title === undefined) continue;
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
      // The studio chrome: an app's own first tab reads "Studio", never
      // "Code" — on every page that carries a repository's header.
      if (html.includes('class="repo-head"')) expect(html).toContain("Studio");

      const title = titleOf(html);
      if (p.title !== undefined)
        expect(title, `${p.word} (${p.path}) titles its tab`).toBe(p.title);
      // The tab is read like `<main>`: the same words, the same reasons.
      const visible = `<title>${title}</title>${pageContent(html)}`;
      for (const { pattern, because } of DEV_WORDS) {
        expect(
          visible,
          `${p.word} (${p.path}) said dev's word ${pattern} — ${because}`,
        ).not.toMatch(pattern);
      }
      for (const noun of RETIRED_NOUNS) {
        expect(
          visible,
          `${p.word} (${p.path}) called an issue or a pull request ${noun} (#3241)`,
        ).not.toMatch(noun);
      }
      expect(html, `${p.word} (${p.path}) linked a retired address`).not.toMatch(
        RETIRED_HREF,
      );
      for (const branch of branches) {
        expect(
          visible,
          `${p.word} (${p.path}) named the branch "${branch}"`,
        ).not.toContain(branch);
      }

      // Which rows landed. A page that rendered nothing at all would pass
      // every vocabulary assertion above, and so would a `?word=` filter or
      // a `cursor` that narrowed nothing — these two are what say the page
      // showed the rows it was asked for and only those.
      for (const shown of p.shows ?? []) {
        expect(
          html,
          `${p.word} (${p.path}) is missing "${shown}" — the page showed less than it was asked for`,
        ).toContain(shown);
      }
      for (const hidden of p.hides ?? []) {
        expect(
          html,
          `${p.word} (${p.path}) still carries "${hidden}" — the filter or the cursor narrowed nothing`,
        ).not.toContain(hidden);
      }
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

  test("the command palette calls them issues and pull requests on an app too (#246, #3241) — it rides a script tag the vocabulary walk above never opens", async () => {
    const res = await fetch(`${base}${repoPath}`, {
      headers: { cookie: `${cookie}; forge_mode=studio` },
      redirect: "manual",
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    const block = html.match(
      /<script type="application\/json" id="palette-index">([\s\S]*?)<\/script>/,
    )?.[1];
    if (block === undefined) throw new Error("no palette-index on the app page");
    const index = JSON.parse(block) as { items: { t: string; h: string }[] };
    const rows = new Map(index.items.map((i) => [i.t, i.h]));

    // Dev's nouns and dev's pages: gone from a studio app's rows.
    for (const t of [
      "alice/vocab — Code",
      "alice/vocab — Commits",
      "alice/vocab — New issue",
      "alice/vocab — Told",
      "alice/vocab — Changes",
    ]) {
      expect(rows.has(t), `palette still offers "${t}" on a studio app page`).toBe(
        false,
      );
    }

    expect(rows.get("alice/vocab — Studio")).toBe(repoPath);
    expect(rows.get("alice/vocab — Issues")).toBe(`${repoPath}/issues`);
    expect(rows.get("alice/vocab — Pull requests")).toBe(`${repoPath}/pulls`);
    // The studio's first verb — telling the crew — reachable from the
    // palette, landing on the app page where the tell box lives.
    expect(rows.get("alice/vocab — Tell the crew")).toBe(`${repoPath}#tell`);
  });

  test("an old ?mode=dev address on any of these routes is the same page without it (#603)", async () => {
    for (const p of pages) {
      const res = await fetch(`${base}${asDev(p.path)}`, {
        headers: { cookie },
        redirect: "manual",
      });
      expect(res.status, asDev(p.path)).toBe(303);
      expect(res.headers.get("location"), asDev(p.path)).toBe(p.path);
    }
  });

  test("a repository that is not an app keeps dev's own titles in the studio mode — the same `studioRecord` rule, not a second one (#262); its lists are the one list (#627)", async () => {
    const alice = getUserByName(app.db, "alice")!;
    const plain = await createRepo(app, alice, {
      name: "plain",
      visibility: "private",
      description: "not an app",
    });
    if (!plain.ok) throw new Error(String(plain.error));
    const titles = new Map([
      ["/alice/plain/issues", "Issues · plain"],
      ["/alice/plain/issues/new", "New issue · plain"],
      ["/alice/plain/pulls", "Pull requests · plain"],
      ["/alice/plain/runs", "Every run · plain"],
    ]);
    for (const [path, title] of titles) {
      const res = await fetch(`${base}${path}`, {
        headers: { cookie: `${cookie}; forge_mode=studio` },
        redirect: "manual",
      });
      expect(res.status, path).toBe(200);
      expect(titleOf(await res.text()), path).toBe(title);
    }
  });

  test("the retired addresses /tells and /changes answer 301 to the issues and pulls pages, query kept, app or not (#3241)", async () => {
    const moved = new Map([
      [`${repoPath}/tells`, `${repoPath}/issues`],
      [`${repoPath}/tells?word=told`, `${repoPath}/issues?word=told`],
      [`${repoPath}/tells/new?title=hi`, `${repoPath}/issues/new?title=hi`],
      [`${repoPath}/tells/${tellNumber}`, `${repoPath}/issues/${tellNumber}`],
      [`${repoPath}/changes`, `${repoPath}/pulls`],
      [`${repoPath}/changes/${openPullNumber}`, `${repoPath}/pulls/${openPullNumber}`],
      ["/alice/plain/tells/new", "/alice/plain/issues/new"],
    ]);
    for (const [from, to] of moved) {
      const res = await fetch(`${base}${from}`, {
        headers: { cookie },
        redirect: "manual",
      });
      expect(res.status, from).toBe(301);
      expect(res.headers.get("location"), from).toBe(to);
    }
  });

  test("reopening a merged change refuses in the reader's own noun — dev's word never rides the flash on a studio page (#171)", async () => {
    const reopen = (mode: "studio" | "dev") =>
      fetch(`${base}/alice/vocab/pulls/${mergedPullNumber}/state`, {
        method: "POST",
        headers: {
          cookie: `${cookie}; forge_mode=${mode}`,
          origin: base,
          accept: "application/json",
        },
        body: new URLSearchParams({ state: "open" }),
      });
    const studio = await reopen("studio");
    expect(studio.status).toBe(422);
    expect(((await studio.json()) as { error: string }).error).toBe(
      "A merged change cannot be reopened.",
    );
    // One forge (#603): an old dev cookie hears the app's own word too.
    const dev = await reopen("dev");
    expect(dev.status).toBe(422);
    expect(((await dev.json()) as { error: string }).error).toBe(
      "A merged change cannot be reopened.",
    );
  });
});

describe("testsClause", () => {
  const run = (summary: string) => ({ summary }) as unknown as Run;

  test("a deploy from before the clause existed says nothing about tests; the two tails say their own", () => {
    expect(testsClause(run("running at http://x"))).toBe("");
    expect(testsClause(null)).toBe("");
    expect(testsClause(run(`running at http://x${TESTS_PASSED_TAIL}`))).toBe(
      "its tests passed",
    );
    expect(testsClause(run(`running at http://x${NO_TESTS_TAIL}`))).toBe(
      "it answered, no tests were run",
    );
  });
});

describe("a preview row's tests verdict", () => {
  const run = (summary: string, commitOid: string, state = "ok") =>
    ({ state, summary, commitOid }) as unknown as Run;
  const env = (state: string, commitOid: string) =>
    ({ state, commitOid }) as unknown as EnvStatus;

  test("speaks only when the green check is of the commit being served", () => {
    const green = run(`running at x${TESTS_PASSED_TAIL}`, "abc");
    expect(previewVerdict(env("running", "abc"), green)).toBe("its tests passed");
    expect(previewVerdict(env("running", "def"), green)).toBeUndefined();
    expect(previewVerdict(env("asleep", "abc"), green)).toBeUndefined();
    expect(previewVerdict(undefined, green)).toBeUndefined();
    expect(
      previewVerdict(env("running", "abc"), run(`x${TESTS_PASSED_TAIL}`, "abc", "failed")),
    ).toBeUndefined();
    expect(previewVerdict(env("running", "abc"), undefined)).toBeUndefined();
  });
});
