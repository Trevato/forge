/**
 * The studio: slot counts, words from facts, a run's page, the tails, and
 * what the front door calls news. One of the files the studio's suite was
 * split into so no one file sets the gate's floor (#2038); the rest are
 * test/studio*.test.ts. It runs in about 2.5 s with no waits (#3578).
 */

import { seatAs } from "./helpers/seat.ts";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { looksPath } from "../src/checks/looks.ts";
import { stepsLine } from "../src/checks/progress.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { enableApp } from "../src/actions/apps.ts";
import type { EnvName } from "../src/apps/data.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { getAppByRepo, type AppRecord } from "../src/core/apps.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import {
  commitToBranch,
  createRepo,
  updateRepoSettings,
} from "../src/actions/repos.ts";
import {} from "../src/core/agents.ts";
import type { Issue } from "../src/core/issues.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import {
  claimRun,
  createRun,
  finishRun,
  getRun,
  markServing,
  noteRunProgress,
  type Run,
} from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import {
  pullWord,
  runWord,
  servingHistory,
  type WordCtx,
} from "../src/web/studio/words.ts";
import { repoDir } from "../src/git/repos.ts";
import { appendRunLog } from "../src/runs/log.ts";
import { withScripts } from "./helpers/page-script.ts";

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
    const a = await createUser(app.db, { origin: "seed", trusted: true,
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
    seatAs(app.db, repo.id, reviewer.id, "reviewer");
    seatAs(app.db, repo.id, planner.id, "planner");
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
    // The crew card says the governor's reason in one line (#7644).
    expect(page).toContain("Builders 2: a quiet hour, 0 of 0 open pulls moving");
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
    const a = await createUser(app.db, { origin: "seed", trusted: true,
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
      // The owner reads it: production's facts are theirs to see.
      viewer: alice,
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
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const b = await createUser(app.db, { origin: "seed", trusted: true,
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

  test("a run's and a tell's heads draw §5's page head and meta row, not .issue-head or .issue-meta", async () => {
    const tell = openIssue(app, alice, repo, { title: "Head check" });
    if (!tell.ok) throw new Error(String(tell.error));
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: tell.value.id,
      actorId: scoutId,
      reason: "assigned",
    });
    const runPage = await (
      await get(`/alice/engine/runs/${run.id}`, writerCookie)
    ).text();
    const tellPage = await (
      await get(`/alice/engine/issues/${tell.value.number}`, writerCookie)
    ).text();
    for (const page of [runPage, tellPage]) {
      expect(page).not.toContain("issue-head");
      expect(page).not.toContain("issue-meta");
      expect(page).toContain('class="page-head"');
      expect(page).toContain('class="page-head-sub bar muted small"');
      expect(page).not.toContain('class="sub');
    }
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
    expect(page).toContain(`href="/alice/engine/issues/${tell.value.number}"`);
    expect(page).toContain("$0.42 spent");
    expect(page).toContain('data-word="working"');
    // An agent's own run still speaks in the agent's name (#195).
    expect(page).toContain('data-who="scout"');
    expect(page).toContain('id="run-steer"');
    expect(page).toContain("Steer scout");
    // Jump, live and steer draw §5's btn, bar and card (#4263).
    for (const old of ["run-jump", "run-live", "run-steer"]) {
      expect(page).not.toMatch(new RegExp(`class="[^"]*\\b${old}\\b`));
    }
    expect(page).toContain("newer below");
    expect(page).toMatch(/<button[^>]*class="btn"[^>]*id="run-jump"/);
    expect(page).toMatch(
      /<form[^>]*class="stack"[^>]*id="run-steer"[^>]*action="\/alice\/engine\/runs\/\w+\/steer"/s,
    );
    // Plain like the home page's tell box, not a boxed card (#9973).
    expect(page).not.toMatch(/<form[^>]*class="[^"]*\bcard\b[^"]*"[^>]*id="run-steer"/s);
    expect(page).toMatch(/<form[^>]*id="run-steer"[^>]*data-api="[^"]+"[^>]*data-running="1"/s);
    expect(page).toContain('for="steer-text"');
    // Not shown without an issue to speak on.
    const bare = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      actorId: scoutId,
      reason: "assigned",
    });
    claimRun(app.db, bare.id);
    const barePage = await (await get(`/alice/engine/runs/${bare.id}`, writerCookie)).text();
    expect(barePage).not.toContain('id="run-steer"');
    expect(page).toContain('name="text"');
    expect(page).toContain('formaction="/alice/engine/runs/');
    expect(page).toContain('id="run-stop"');
    // The transcript is on the page, and there is no second reading of it.
    expect(page).toContain('id="run-log"');
    expect(page).not.toContain("?mode=dev");
    // The summary is a plain paragraph, not a page-part class (#3960).
    expect(page).toMatch(/<p class="mt" id="run-summary">/);
    expect(page).not.toContain('class="run-summary"');
    expect(page).not.toContain("run-actions");
  });

  test("the steer box is a writer's, on an agent run with an issue, never for a reader or a signed-out visitor", async () => {
    const made = await createRepo(app, alice, {
      name: "open",
      visibility: "public",
      description: "a public app",
    });
    if (!made.ok) throw new Error(String(made.error));
    const open = made.value;
    const seeded = await commitToBranch(app, alice, open, {
      message: "Start",
      files: [{ path: "README.md", content: "open\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const tell = openIssue(app, alice, open, { title: "Steer me" });
    if (!tell.ok) throw new Error(String(tell.error));
    const mk = (issueId?: string) => {
      const run = createRun(app.db, {
        repoId: open.id,
        kind: "agent",
        issueId,
        actorId: scoutId,
        reason: "assigned",
      });
      claimRun(app.db, run.id);
      return run;
    };
    const page = async (id: string, cookie?: string) => {
      const res = await fetch(`${base}/alice/open/runs/${id}`, {
        headers: { cookie: `${cookie ?? ""}; forge_mode=studio` },
        redirect: "manual",
      });
      return { status: res.status, text: await res.text() };
    };
    const live = mk(tell.value.id);
    const asWriter = await page(live.id, writerCookie);
    expect(asWriter.status).toBe(200);
    expect(asWriter.text).toContain('id="steer-text"');
    expect(asWriter.text).toContain('id="run-steer"');
    // A reader of a public repository sees the run, not the box.
    const asReader = await page(live.id, readerCookie);
    expect(asReader.status).toBe(200);
    expect(asReader.text).toContain('data-word=');
    expect(asReader.text).not.toContain('id="steer-text"');
    expect(asReader.text).not.toContain('id="run-steer"');
    const signedOut = await page(live.id);
    expect(signedOut.status).toBe(200);
    expect(signedOut.text).toContain('data-word=');
    expect(signedOut.text).not.toContain('id="steer-text"');
    expect(signedOut.text).not.toContain('id="run-steer"');
    // No issue to speak on: no box, even to a writer.
    const bare = mk();
    const bareWriter = await page(bare.id, writerCookie);
    expect(bareWriter.status).toBe(200);
    expect(bareWriter.text).toContain('data-word=');
    expect(bareWriter.text).not.toContain('id="steer-text"');
    // A finished run keeps the box for a writer only, as "tell it for its
    // next run" (the comment starts a run); a reader never gets it.
    finishRun(app.db, live.id, { state: "ok", summary: "done" });
    const over = await page(live.id, writerCookie);
    expect(over.text).toContain('data-running="0"');
    expect(over.text).toContain("The run is over");
    for (const cookie of [readerCookie, undefined]) {
      const seen = await page(live.id, cookie);
      expect(seen.status).toBe(200);
      expect(seen.text).not.toContain('id="steer-text"');
      expect(seen.text).not.toContain('id="run-steer"');
    }
  });

  test("the cancel form sits in a .bar.mt row for an issue-less agent run and a non-agent run", async () => {
    const agent = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      actorId: scoutId,
      reason: "assigned",
    });
    claimRun(app.db, agent.id);
    const check = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      reason: "push",
    });
    for (const [run, label] of [
      [agent, "Stop"],
      [check, "Cancel run"],
    ] as const) {
      const page = await (
        await get(`/alice/engine/runs/${run.id}`, writerCookie)
      ).text();
      expect(page).toMatch(
        new RegExp(
          `<div class="bar mt" id="run-cancel">\\s*<form method="post" action="/alice/engine/runs/${run.id}/cancel">[\\s\\S]*?${label}[\\s\\S]*?</form>`,
        ),
      );
    }
  });

  test("a running run's page reads its log from the one /events stream and opens no other", async () => {
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      actorId: scoutId,
      reason: "assigned",
    });
    claimRun(app.db, run.id);
    appendRunLog(app.config.dataDir, run.id, "first");
    appendRunLog(app.config.dataDir, run.id, "second");

    const page = await withScripts(
      base,
      await (await get(`/alice/engine/runs/${run.id}`, writerCookie)).text(),
    );
    // Every EventSource the page's HTML and script open is /events.
    const opened = [...page.matchAll(/new EventSource\(([^,;]*)/g)].map(
      (m) => m[1]!,
    );
    expect(opened.length).toBeGreaterThan(0);
    for (const arg of opened) expect(arg).toStartWith("'/events");
    // The connection is really opened: liveRegionsJs only connects when the
    // page has a [data-live] element, and a script's text proves nothing.
    expect(page).toMatch(/<div[^>]*id="run-head"[^>]*data-live="run\.\*"/);
    expect(page).toContain('id="run-conn"');
    expect(page).not.toContain("follow=1");
    expect(page).not.toContain("data-stream=");
    // The run's frames arrive on that connection; the file's lines are
    // counted so none is drawn twice.
    expect(page).toContain("'run.log'");
    expect(page).toContain("forge:run-log");
    expect(page).toContain(`data-run="${run.id}"`);
    expect(page).toContain('data-seen="2"');
    expect(page).toContain(">second<");
  });

  test("a running run's page never reloads itself: its head is the live region, and once over it shows the final state", async () => {
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      actorId: scoutId,
      reason: "assigned",
    });
    claimRun(app.db, run.id);
    noteRunProgress(app.db, run.id, { costUsd: 0.25 });
    const path = `/alice/engine/runs/${run.id}`;
    const head = (html: string): string =>
      html.slice(html.indexOf('id="run-head"'), html.indexOf('id="run-live"'));

    const going = await (await get(path, writerCookie)).text();
    expect(going).not.toMatch(/<meta\s+http-equiv="refresh"/);
    // Word, cost and clock sit in one region, swapped in place on any
    // run.* event about this repository and no other.
    expect(going).toMatch(
      /<div\s+class="page-head"\s+id="run-head"\s+data-live="run\.\*"\s+data-live-repo="alice\/engine"/,
    );
    expect(going).not.toContain("issue-head");
    expect(going).not.toContain("issue-meta");
    expect(head(going)).toContain('data-word="working"');
    expect(head(going)).toContain("$0.25 spent");
    expect(head(going)).toContain("running for");

    finishRun(app.db, run.id, { state: "ok", summary: "planned" });
    const over = await (await get(path, writerCookie)).text();
    expect(over).not.toMatch(/<meta\s+http-equiv="refresh"/);
    // The same region by id, so the swap on run.finished finds its match,
    // carrying the final word, cost and summary; nothing is listening now.
    expect(over).toContain('id="run-head"');
    expect(over).not.toMatch(/id="run-head"[^>]*data-live=/);
    expect(head(over)).toContain('data-word="planned"');
    expect(head(over)).toContain("$0.25 spent");
    expect(head(over)).toContain("took");
    expect(head(over)).toContain(">planned<");
    expect(over).not.toContain('id="run-conn"');
    expect(over).not.toContain('id="run-stop"');
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
    expect(page).toContain('>the deploy<');
    expect(page).not.toContain("an agent");
    // A deploy that finished with nothing else to show reads as done, not
    // as a run that has not started yet.
    expect(page).toContain('data-word="done"');
    expect(page).not.toContain('data-word="planned"');
    // Sub-second, in tenths — not rounded away to "took 0s".
    expect(page).toContain(">took 0.3s<");
  });

  const stepStates = (page: string) =>
    [...page.matchAll(/<li data-step="(\w+)" data-state="(\w+)"/g)].map(
      (m) => `${m[1]}:${m[2]}`,
    );

  test("a running check's page has its three step rows from the first paint: install done, tests running", async () => {
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      commitOid: "c740479",
      reason: "push",
    });
    claimRun(app.db, run.id);
    for (const line of [
      "$ bun install",
      "$ bun scripts/gate.ts && tsc && bun scripts/test-shards.ts",
      "test-shards: 12 files",
      "── shard 1/2: test/a.test.ts",
    ])
      appendRunLog(app.config.dataDir, run.id, line);
    const page = await (
      await get(`/alice/engine/runs/${run.id}`, writerCookie)
    ).text();
    expect(stepStates(page)).toEqual([
      "install:ok",
      "typecheck:ok",
      "tests:running",
    ]);
  });

  test("a running check's page always has the bar and words, pins the failure outside the live region, and hides all from a reader without the log", async () => {
    const mk = (lines: string[]) => {
      const r = createRun(app.db, {
        repoId: repo.id,
        kind: "check",
        commitOid: "c740479",
        reason: "push",
      });
      claimRun(app.db, r.id);
      for (const l of lines) appendRunLog(app.config.dataDir, r.id, l);
      return r;
    };
    const run = mk([
      "$ bun install",
      "$ gate && tsc && bun scripts/test-shards.ts",
      "test-shards: 9 files in 3 shards",
      "── shard 1/3: test/a.test.ts",
      "error: <b>boom</b>",
      "(fail) a breaks",
      " 4 pass",
      " 1 fail",
      "── shard 1/3 done (exit 1, 2.0s)",
      "── shard 2/3: test/b.test.ts",
    ]);
    // A recorded look is on the page, escaped, and in the terminal's line.
    const noLooks = await (await get(`/alice/engine/runs/${run.id}`, writerCookie)).text();
    expect(noLooks).not.toContain("vitals");
    writeFileSync(
      looksPath(app.config.dataDir, run.id),
      JSON.stringify([
        { look: "<b>home</b>", entries: { layoutShift: [{ startTime: 1, value: 0.3 }] } },
        { look: "mobile", skipped: "no browser" },
      ]),
    );
    const seen = await (await get(`/alice/engine/runs/${run.id}`, writerCookie)).text();
    expect(seen).toContain("<td>CLS</td><td>0.3</td>");
    expect(seen).toContain("&lt;b&gt;home&lt;/b&gt;");
    expect(seen).toContain("skipped: no browser");
    expect(stepsLine(app.config.dataDir, { state: "running", run }, true)).toContain(
      "vitals <b>home</b>: LCP n/a, CLS 0.3 poor, TBT 0 ms good; mobile: skipped: no browser",
    );
    expect(stepsLine(app.config.dataDir, { state: "running", run }, false)).toBe("");
    const page = await (await get(`/alice/engine/runs/${run.id}`, writerCookie)).text();
    expect(page).toContain('<progress aria-label="Test files started" max="9" value="2"');
    expect(page).toContain("2 of 9 files started · 4 passed, 1 failed · running test/b.test.ts");
    expect(page).toContain('<strong class="break">a breaks</strong>');
    expect(page).toContain("error: &lt;b&gt;boom&lt;/b&gt;");
    // The pins sit after the live region closes.
    const live = page.indexOf('role="status"');
    expect(live).toBeGreaterThan(-1);
    expect(page.indexOf('id="check-pins"')).toBeGreaterThan(page.indexOf("Test files"));
    expect(page.slice(live, page.indexOf('id="check-pins"'))).not.toContain("a breaks");
    // The steps are bare rows, not a boxed card (#9727).
    expect(page.slice(page.indexOf('id="check-steps"'), page.indexOf('id="check-pins"'))).toMatch(
      /<div\s+class="card bare"[^>]*>\s*<ul class="list">/,
    );
    // The replaced element (#check-steps) closes before the pin slot, which is
    // patched in place so focus and scroll survive a refetch.
    const at = page.indexOf('id="check-steps"');
    expect(page.slice(at, page.indexOf('id="check-pins"'))).toContain("</div>");
    expect(page.slice(at, page.indexOf('id="check-pins"')).match(/<div/g)?.length).toBe(
      page.slice(at, page.indexOf('id="check-pins"')).match(/<\/div>/g)?.length,
    );
    // Nothing logged yet: the bar and the line are still there, empty.
    const fresh = mk([]);
    const quiet = await (await get(`/alice/engine/runs/${fresh.id}`, writerCookie)).text();
    expect(quiet).toContain('<progress aria-label="Test files started"></progress>');
    const block = quiet.slice(quiet.indexOf('id="check-steps"'), quiet.indexOf('id="run-live"'));
    expect(block).not.toContain("value=");
    expect(block).not.toContain("tabindex");
    expect(block).not.toContain('role="region"');
    // With pins, the slot is focusable and labelled; the live region holds no pin.
    expect(page).toContain('data-pins id="check-pins" role="region" tabindex="0" aria-label="Failed tests"');
    expect(page).not.toMatch(/data-pins[^>]*class="[^"]*stack/);
    expect(page).not.toContain("pinned-failures");
    expect(page).not.toContain("pinned-slot");
    expect(page.slice(page.indexOf('id="check-pins"'))).toMatch(/class="card"\s+data-tone="danger"/);
    expect(page.slice(live, page.indexOf(`id="check-pins"`, live))).toContain("2 of 9 files started");
    expect(quiet).toContain('<p class="check-words small muted break"></p>'); // empty, but still rendered
    for (const old of ["tests-bar", "tests-words"]) {
      expect(page).not.toContain(old);
      expect(quiet).not.toContain(old);
    }
    // A finished run with no known count shows no bar at all.
    const done = mk(["$ bun install"]);
    finishRun(app.db, done.id, { state: "failed", summary: "x" });
    const ended = await (await get(`/alice/engine/runs/${done.id}`, writerCookie)).text();
    expect(ended).toContain("check-progress");
    // Drawn from the design system: the old bespoke classes are gone.
    for (const old of ['class="check-steps"', 'class="check-progress"', "step-state", "step-name"]) {
      expect(ended).not.toContain(old);
      expect(page).not.toContain(old);
    }
    expect(page).toContain('data-step="');
    expect(page).toContain("data-check-progress");
    expect(ended).not.toContain("<progress");
    // No look has recorded vitals yet: the run page renders no table, not an empty one.
    expect(ended).not.toContain("vitals");
    // A reader the log is hidden from gets none of it.
    const plain = await createRepo(app, alice, { name: "plainb", visibility: "public", description: "x" });
    if (!plain.ok) throw new Error(String(plain.error));
    const hidden = createRun(app.db, { repoId: plain.value.id, kind: "check", commitOid: "c740479", reason: "push" });
    claimRun(app.db, hidden.id);
    appendRunLog(app.config.dataDir, hidden.id, "(fail) secret");
    const hid = await (await get(`/alice/plainb/runs/${hidden.id}`, readerCookie)).text();
    expect(hid).not.toContain("tests-bar");
    expect(hid).not.toContain("secret");
  });

  test("the page re-reads its rows as the run goes, and a reader who cannot see the log gets none", async () => {
    const script = await (
      await get(
        `/alice/engine/runs/${
          (
            createRun(app.db, {
              repoId: repo.id,
              kind: "check",
              commitOid: "c740479",
              reason: "push",
            })
          ).id
        }`,
        writerCookie,
      )
    ).text();
    const scripts = await withScripts(base, script);
    expect(scripts).toContain("getElementById('check-steps')");
    expect(scripts).toContain("\\(fail\\) ");
    expect(scripts).toContain("['role', 'tabindex', 'aria-label']");
    const plain = await createRepo(app, alice, {
      name: "plain",
      visibility: "public",
      description: "no app",
    });
    if (!plain.ok) throw new Error(String(plain.error));
    const hidden = createRun(app.db, {
      repoId: plain.value.id,
      kind: "check",
      commitOid: "c740479",
      reason: "push",
    });
    claimRun(app.db, hidden.id);
    appendRunLog(app.config.dataDir, hidden.id, "$ bun install");
    const page = await (
      await get(`/alice/plain/runs/${hidden.id}`, readerCookie)
    ).text();
    expect(page).toContain('id="run-log-hidden"');
    expect(page).not.toContain('id="check-steps"');
  });

  test("a finished red check's page shows tests failed, and a fresh one still has three rows", async () => {
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      commitOid: "c740479",
      reason: "push",
    });
    claimRun(app.db, run.id);
    for (const line of ["$ bun install", "$ bun test", "test-shards: 3 files"])
      appendRunLog(app.config.dataDir, run.id, line);
    finishRun(app.db, run.id, { state: "failed", summary: "1 of 3 tests" });
    const page = await (
      await get(`/alice/engine/runs/${run.id}`, writerCookie)
    ).text();
    expect(stepStates(page)).toEqual([
      "install:ok",
      "typecheck:ok",
      "tests:failed",
    ]);
    const fresh = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      commitOid: "c740479",
      reason: "push",
    });
    const queued = await (
      await get(`/alice/engine/runs/${fresh.id}`, writerCookie)
    ).text();
    expect(stepStates(queued)).toEqual([
      "install:pending",
      "typecheck:pending",
      "tests:pending",
    ]);
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
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const b = await createUser(app.db, { origin: "seed", trusted: true,
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

  test("the app's page carries the tail of the active run's log, bounded, and never reloads itself", async () => {
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
    // The retired one-off class is gone from the HTML.
    expect(page).not.toContain("log-tail-row");
    // The block-level log box is a sibling <li> padded by §5's .card-body,
    // never inside a row's ellipsizing, nowrap .row-title, so its lines wrap.
    expect(page).toMatch(/<li class="card-body">\s*<[^>]*id="app-run-tail"/);
    expect(page).not.toMatch(
      /<span\s+class="row-title"[^>]*>(?:(?!<\/span>)[\s\S])*id="app-run-tail"/,
    );
    // Bounded on the first paint too: only the last handful made it, and
    // the box says so.
    expect(page).not.toContain(">line 0<");
    expect(page).toContain(">line 8<");
    expect(page).toContain("Holding the last 6 lines here");
    // The page never reloads itself (#2873): the Now card is a live region
    // for this repository's runs, and the tail rides the one /events stream.
    expect(page).not.toMatch(/<meta\s+http-equiv="refresh"/);
    expect(page).toMatch(
      /id="live-now"\s+data-live="run\.queued,run\.started,run\.finished[^"]*"\s+data-live-repo="alice\/engine"/,
    );

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

  // A fresh app for each test: one test's tell or run would otherwise fill
  // "Now" for the next, and its production slot stand in for the next's.
  beforeEach(async () => {
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
    const a = await createUser(app.db, { origin: "seed", trusted: true,
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

  afterEach(async () => {
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
    // The page never reloads itself while the deploy goes (#2873): the head
    // card swaps in place on the deploy's run events.
    expect(page).not.toMatch(/<meta\s+http-equiv="refresh"/);
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
    // Still nothing to fetch, and the page does not reload in case that
    // changes (#2873): the head card swaps in place when production moves.
    expect(page).not.toMatch(/<meta\s+http-equiv="refresh"/);
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
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    const c = await createUser(app.db, { origin: "seed", trusted: true,
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
    expect(page).not.toMatch(/<meta\s+http-equiv="refresh"/);

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
    const a = await createUser(app.db, { origin: "seed", trusted: true,
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
 * Issue #183: `tell` cannot route a tell to anyone with nobody on the
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
    // No crew at all — the exact state `tell` cannot route out of. Every
    // test below reads the one tell told into it here.
    const told = await post("/alice/pad/tell", {
      text: "Add a dark mode toggle.",
    });
    if (told.status !== 303) throw new Error(`tell: ${told.status}`);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test('a crewless tell renders a "Now" row, not the empty state, and links to where a crew member is added', async () => {
    const page = await (await get("/alice/pad")).text();
    expect(page).not.toContain("Nothing yet. Tell the crew something.");
    expect(page).toContain("Add a dark mode toggle.");
    expect(page).toContain("nobody on the crew to take it");
    expect(page).toContain(`href="/alice/pad/settings"`);
  });

  test('the shelf row for that app is not "quiet"', async () => {
    const home = await (await get("/apps")).text();
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
    const b = await createUser(app.db, { origin: "seed", trusted: true,
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
    const home = await (await get("/apps")).text();
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
    const home = await (await get("/apps")).text();
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

  // Each test starts from the merge's deploy serving just now; a test that
  // wants another production slot puts its own.
  beforeEach(() => {
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
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the shelf row reads shipped, with who and when, not quiet", async () => {
    const home = await (await get("/apps")).text();
    const shelfRow = shelfRowFor(home, "/alice/sap");
    expect(shelfRow).not.toContain("quiet — tell the crew something");
    expect(shelfRow).toContain('data-word="shipped"');
    expect(shelfRow).toContain("alice");
  });

  test("an app with no recent deploy still reads quiet", async () => {
    const home = await (await get("/apps")).text();
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
    const home = await (await get("/apps")).text();
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
    const home = await (await get("/apps")).text();
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

describe("the pin slot's stylesheet", () => {
  test("caps [data-pins] with scroll and reserves it while a check is open", async () => {
    const { css } = await import("../src/web/style.ts");
    expect(css).toContain("[data-pins] { max-height: 9em; overflow-y: auto; }");
    expect(css).toContain('[data-check-progress][data-state="running"] [data-pins] { height: 9em; }');
    expect(css).toContain('[data-check-progress][data-state="queued"] [data-pins]');
    expect(css).not.toContain(".pinned-");
    // Cards stack as blocks (a flex column would squash them into 9em), and output wraps.
    expect(css).toContain("[data-pins] .card + .card { margin-top: 12px; }");
    expect(css).toContain("[data-pins] pre { margin: 4px 0 0; white-space: pre-wrap; font-size: var(--fs-min); }");
  });
  test("the slot is not a flex column", async () => {
    const { css } = await import("../src/web/style.ts");
    expect(css).not.toMatch(/\[data-pins\][^{]*\{[^}]*display:\s*(flex|grid)/);
  });
});

describe("run page controls leave the old classes behind (#4263)", () => {
  test("no run-jump, run-live or run-steer class selector is defined, and [hidden] still beats .btn", async () => {
    const { css } = await import("../src/web/style.ts");
    for (const old of ["run-jump", "run-live", "run-steer"]) {
      expect(css).not.toMatch(new RegExp(`\\.${old}(?![\\w-])`));
    }
    // The layout is kept under the ids the client script already uses.
    expect(css).toMatch(/#run-steer \{[^}]*position: sticky/);
    expect(css).toMatch(/#run-jump \{[^}]*position: sticky/);
    expect(css).toMatch(/\[hidden\] \{ display: none !important; \}/);
  });
});
