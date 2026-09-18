/**
 * The studio: apps as the unit, three verbs, and a switch to dev. The same
 * URLs answer in both modes; the cookie decides which face they show.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { enableApp } from "../src/actions/apps.ts";
import { previewEnv, type EnvName } from "../src/apps/data.ts";
import { AppsRuntime, type EnvStatus } from "../src/apps/runtime.ts";
import { getAppByRepo, type AppRecord } from "../src/core/apps.ts";
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
import { setCrewRole } from "../src/core/agents.ts";
import { recordDecision } from "../src/core/decisions.ts";
import { getIssue, listIssues, type Issue } from "../src/core/issues.ts";
import { recordLook } from "../src/core/looks.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import { setDirectionIssue, type Repo } from "../src/core/repos.ts";
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
import type { Decider } from "../src/crew/decide.ts";
import { CHECK_FAILED_LIMIT } from "../src/crew/dispatch.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { pendingLeans, pullWord, runWord, type WordCtx } from "../src/web/pages/studio.ts";
import { servedPhrase } from "../src/web/ui.ts";
import { repoDir } from "../src/git/repos.ts";

/** One transparent pixel, dropped where a look would sit. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

describe("the studio", () => {
  test("the asks script posts to the form's action attribute: a control named action shadows form.action", async () => {
    const { asksJs } = await import("../src/web/client.ts");
    expect(asksJs).not.toContain("form.action,");
    expect(asksJs).toContain("getAttribute('action')");
  });

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
    const a = await createUser(app.db, {
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
    const toStudio = await fetch(`${base}/?mode=studio`, { headers: { cookie } });
    expect(toStudio.headers.get("set-cookie")).toContain("forge_mode=studio");

    const devResponse = await fetch(`${base}/?mode=dev`, { headers: { cookie } });
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
      await fetch(`${base}/`, { headers: { cookie: `${cookie}; ${devCookie}` } })
    ).text();
    expect(asDev).toContain("<h1>Your repositories</h1>");

    // The toggle's own POST still flips it back, cookie and all.
    const flipped = await post("/mode", { mode: "studio", back: "/" });
    expect(flipped.status).toBe(303);
    expect(flipped.headers.get("set-cookie")).toContain("forge_mode=studio");
    const bad = await post("/mode", { mode: "neither", back: "/" });
    expect(bad.headers.get("set-cookie")).toContain("forge_mode=;");
  });

  test("an app's home is the app in the studio, and the code in dev", async () => {
    const studio = await (await get("/alice/notes")).text();
    expect(studio).toContain("Tell the crew");
    expect(studio).toContain("<h2>Crew</h2>");
    expect(studio).toContain(">Studio<");
    expect(studio).not.toContain(">Commits<");
    const dev = await (
      await get("/alice/notes", { cookie: `${cookie}; forge_mode=dev` })
    ).text();
    expect(dev).not.toContain("Tell the crew");
    expect(dev).toContain(">Commits<");
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
    expect(studio).toContain(`href="/alice/notes/app/pull-${pull.number}/open"`);
    expect(studio).toContain("data-word=\"look\"");
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

  test("a tell on an app renders as a studio page — who has it, its runs, what blocks it, and no label form; ?mode=dev still renders today's page", async () => {
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
    expect(studio).toContain(`href="/alice/notes/issues/${blocker.value.number}"`);
    expect(studio).toContain('data-word="working"');
    expect(studio).toContain("$0.12");
    expect(studio).toContain('id="comment-body"');
    expect(studio).not.toContain("<h2>Labels</h2>");
    expect(studio).not.toContain("Apply labels");
    expect(studio).toContain(
      `href="/alice/notes/issues/${issue.number}?mode=dev"`,
    );

    const dev = await (
      await get(`/alice/notes/issues/${issue.number}`, {
        cookie: `${cookie}; forge_mode=dev`,
      })
    ).text();
    expect(dev).toContain("<h2>Labels</h2>");
    expect(dev).toContain("<h2>Assignee</h2>");
    expect(dev).toContain("<h2>Depends on</h2>");
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

  test("everything told is the issue list in the studio's own words; the word filter narrows it, and ?mode=dev renders today's list", async () => {
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
    expect(page).not.toContain(
      `>#${told.value.number} opened`,
    );
    expect(page).toContain(`href="/alice/notes/issues?word=told"`);

    const filtered = await (
      await get("/alice/notes/issues?word=told")
    ).text();
    expect(filtered).toContain("List test: not picked up yet");
    const other = await (
      await get("/alice/notes/issues?word=shipped")
    ).text();
    expect(other).not.toContain("List test: not picked up yet");

    const dev = await (
      await get("/alice/notes/issues", { cookie: `${cookie}; forge_mode=dev` })
    ).text();
    expect(dev).toContain(`>#${told.value.number} opened`);
    expect(dev).not.toContain("data-word=");
  });

  test("every change is the pull list in the studio's own words; the word filter narrows it, and ?mode=dev renders today's list", async () => {
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
    expect(page).not.toContain(
      `${pull.headBranch} &rarr; ${pull.baseBranch}`,
    );
    expect(page).not.toContain(`${pull.headBranch}`);

    const filtered = await (
      await get("/alice/notes/pulls?word=look")
    ).text();
    expect(filtered).toContain("List test: a green change");
    const other = await (
      await get("/alice/notes/pulls?word=shipped")
    ).text();
    expect(other).not.toContain("List test: a green change");

    const dev = await (
      await get("/alice/notes/pulls", { cookie: `${cookie}; forge_mode=dev` })
    ).text();
    expect(dev).toContain(pull.headBranch);
    expect(dev).not.toContain("data-word=");
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

    const filtered = await (
      await get("/alice/notes/runs?word=working")
    ).text();
    expect(filtered).toContain(`href="/alice/notes/runs/${run.id}"`);
    const other = await (
      await get("/alice/notes/runs?word=shipped")
    ).text();
    expect(other).not.toContain(`href="/alice/notes/runs/${run.id}"`);

    finishRun(app.db, run.id, { state: "failed", summary: "boom" });
    const dev = await (
      await get("/alice/notes/runs", { cookie: `${cookie}; forge_mode=dev` })
    ).text();
    expect(dev).toContain("Failed");
    expect(dev).not.toContain("data-word=");
  });

  test("issues, pulls and runs on a repository that is not an app render exactly what they render today, even in studio mode", async () => {
    const plain = await createRepo(app, alice, {
      name: "plainlists",
      visibility: "private",
      description: "no app here",
    });
    if (!plain.ok) throw new Error(String(plain.error));

    const issues = await (await get("/alice/plainlists/issues")).text();
    expect(issues).not.toContain(">Told<");
    expect(issues).not.toContain("See dev's list");

    const pulls = await (await get("/alice/plainlists/pulls")).text();
    expect(pulls).not.toContain(">Look<");
    expect(pulls).not.toContain("See dev's list");

    const runs = await (await get("/alice/plainlists/runs")).text();
    expect(runs).not.toContain(">Working<");
    expect(runs).not.toContain("See dev's list");
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

  test("several asks, one decision: a box per ask, one bar, one post; in place when asked for JSON", async () => {
    const scout = getUserByName(app.db, "scout")!;
    // The crew proposes: a pull by scout on its own branch.
    const ask = async (name: string): Promise<Pull> => {
      const branch = await commitToBranch(app, alice, repo, {
        branch: `ask/${name}`,
        base: "main",
        message: `Ask ${name}`,
        files: [{ path: `${name}.md`, content: `${name}\n` }],
      });
      if (!branch.ok) throw new Error(JSON.stringify(branch.error));
      const opened = await openPull(app, scout, repo, {
        title: `Ask ${name}`,
        body: "",
        baseBranch: "main",
        headBranch: `ask/${name}`,
      });
      if (!opened.ok) throw new Error(String(opened.error));
      return opened.value;
    };
    const check = (pull: Pull, state: "ok" | "failed") => {
      const run = createRun(app.db, {
        repoId: repo.id,
        kind: "check",
        issueId: pull.id,
        env: `pull-${pull.number}`,
        commitOid: pull.headOid,
        reason: "pull",
      });
      claimRun(app.db, run.id);
      finishRun(app.db, run.id, { state, summary: `check ${state}` });
    };
    const a = await ask("a");
    const b = await ask("b");
    const c = await ask("c");
    const d = await ask("d");
    check(a, "ok");
    check(b, "ok");
    check(d, "ok");
    // c: red, and the crew tried its limit since anyone spoke — it stopped.
    check(c, "failed");
    await Bun.sleep(5);
    // Each try is over: a run still queued or running would make c the
    // crew's, not a question for a person.
    for (let i = 0; i < CHECK_FAILED_LIMIT; i++) {
      const tried = createRun(app.db, {
        repoId: repo.id,
        kind: "agent",
        issueId: c.id,
        reason: "check_failed",
        actorId: scout.id,
      });
      claimRun(app.db, tried.id);
      finishRun(app.db, tried.id, { state: "failed", summary: "still red" });
    }

    // (a) One box per ask, one form around them, the bar's actions, and a
    // row's own form outside the panel's — never a form in a form.
    const page = await (await get("/alice/notes")).text();
    expect(page.match(/class="studio-ask-pick"/g)?.length).toBe(4);
    expect(page).toContain(`value="look:${a.id}"`);
    expect(page).toContain(`value="stopped:${c.id}"`);
    expect(page).toContain('action="/studio/asks"');
    expect(page).toMatch(/name="action"\s+value="ship"/);
    expect(page).toMatch(/name="action"\s+value="close"/);
    expect(page).toContain(`form="ask-look:${a.id}"`);
    expect(page).toContain(`id="ask-look:${a.id}"`);
    expect(page).toContain(`id="ask-stopped:${c.id}"`);
    const panel = page.slice(page.indexOf('action="/studio/asks"'));
    expect(panel.slice(0, panel.indexOf("</form>"))).not.toContain("<form");

    // (b) One decision for two; the third does not take it and is skipped.
    const bulk = (body: [string, string][], accept?: string) =>
      fetch(`${base}/studio/asks`, {
        method: "POST",
        headers: {
          cookie: `${cookie}; forge_mode=studio`,
          origin: base,
          ...(accept === undefined ? {} : { accept }),
        },
        body: new URLSearchParams(body),
        redirect: "manual",
      });
    const shipped = await bulk([
      ["ask", `look:${a.id}`],
      ["ask", `look:${b.id}`],
      ["ask", `stopped:${c.id}`],
      ["action", "ship"],
      ["back", "/alice/notes"],
    ]);
    expect(shipped.status).toBe(303);
    expect(shipped.headers.get("location")).toBe("/alice/notes");
    expect(
      decodeURIComponent(shipped.headers.get("set-cookie") ?? ""),
    ).toContain("Shipped 2 · skipped 1");
    expect(getPull(app.db, repo.id, a.number)?.mergedAt).not.toBeNull();
    expect(getPull(app.db, repo.id, b.number)?.mergedAt).not.toBeNull();
    expect(getPull(app.db, repo.id, c.number)?.state).toBe("open");

    // (c) Asked for JSON, the route says what was done and what was skipped
    // — an ask already decided is skipped, not guessed at.
    const closed = await bulk(
      [
        ["ask", `stopped:${c.id}`],
        ["ask", `look:${a.id}`],
        ["action", "close"],
      ],
      "application/json",
    );
    expect(closed.status).toBe(200);
    expect(await closed.json()).toEqual({
      ok: true,
      flash: "Closed 1 · skipped 1",
      done: [`stopped:${c.id}`],
      skipped: [`look:${a.id}`],
      failed: [],
    });
    expect(getPull(app.db, repo.id, c.number)?.state).toBe("closed");
    const nothing = await bulk(
      [
        ["ask", "look:nothing"],
        ["action", "close"],
      ],
      "application/json",
    );
    expect(nothing.status).toBe(422);
    expect(await nothing.json()).toEqual({
      ok: false,
      error: "Closed 0 · skipped 1",
      done: [],
      skipped: ["look:nothing"],
      failed: [],
    });

    // (d) A row's own button answers the same two ways: JSON when asked,
    // the redirect and flash otherwise.
    const ship = (accept?: string) =>
      fetch(`${base}/alice/notes/pulls/${d.number}/ship`, {
        method: "POST",
        headers: {
          cookie: `${cookie}; forge_mode=studio`,
          origin: base,
          ...(accept === undefined ? {} : { accept }),
        },
        redirect: "manual",
      });
    const inPlace = await ship("application/json");
    expect(inPlace.status).toBe(200);
    expect(await inPlace.json()).toEqual({
      ok: true,
      flash: 'Shipped "Ask d". Production is redeploying.',
    });
    expect(getPull(app.db, repo.id, d.number)?.mergedAt).not.toBeNull();
    const refused = await ship("application/json");
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ ok: false });
    const plain = await ship();
    expect(plain.status).toBe(303);
    expect(plain.headers.get("location")).toBe("/alice/notes");
    // Nothing asks any more: no box, no panel.
    const after = await (await get("/alice/notes")).text();
    expect(after).not.toContain('class="studio-ask-pick"');
    expect(after).not.toContain('action="/studio/asks"');
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
          content: '{"name":"beacon","scripts":{"start":"bun run server.ts"}}\n',
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
      const rel = join("looks", appId, `${env}-desktop.png`);
      const abs = join(app.config.dataDir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, PNG);
      return recordLook(app.db, {
        appId,
        env,
        commitOid: commit,
        kind: "desktop",
        path: rel,
      });
    };
    const beaconApp = getAppByRepo(app.db, beacon.id)!;
    const notesApp = getAppByRepo(app.db, repo.id)!;
    dropLook(beaconApp.id, "production", seededPublic.value.commitOid);
    dropLook(notesApp.id, "production", "0".repeat(40));

    // Signed out, with the studio cookie: the public app's name, its look,
    // and Sign in / Create an account — never the private one.
    const anon = await (
      await fetch(`${base}/`, { headers: { cookie: "forge_mode=studio" } })
    ).text();
    expect(anon).toContain("beacon");
    expect(anon).toContain("a lighthouse in the fog");
    expect(anon).toContain(`/looks/production/${seededPublic.value.commitOid}/desktop.png`);
    expect(anon).toContain('href="/signin"');
    expect(anon).toContain('href="/signup"');
    expect(anon).not.toContain(">notes<");
    expect(anon).not.toContain("Your code, your machine");

    // The private app's picture 404s for a stranger — asserted, not assumed.
    const privateLook = await fetch(
      `${base}/alice/notes/looks/production/${"0".repeat(40)}/desktop.png`,
      { headers: { cookie: "forge_mode=studio" } },
    );
    expect(privateLook.status).toBe(404);
    // The public one's does not.
    const publicLook = await fetch(
      `${base}/alice/beacon/looks/production/${seededPublic.value.commitOid}/desktop.png`,
      { headers: { cookie: "forge_mode=studio" } },
    );
    expect(publicLook.status).toBe(200);

    // `?mode=dev` still renders the dev landing, unchanged, for a stranger.
    const dev = await (
      await fetch(`${base}/?mode=dev`, {
        headers: { cookie: "forge_mode=studio" },
      })
    ).text();
    expect(dev).toContain("Your code, your machine");
  });

  test("a forge with no public apps falls back to the dev landing, signed out in studio", async () => {
    const dataDir2 = await mkdtemp(join(tmpdir(), "forge-studio-empty-"));
    const app2 = createApp({ dataDir: dataDir2, port: 0 });
    const servers2 = await serve(app2);
    try {
      const body = await (
        await fetch(`${servers2.url}/`, {
          headers: { cookie: "forge_mode=studio" },
        })
      ).text();
      expect(body).toContain("Your code, your machine");
    } finally {
      servers2.stop();
      app2.close();
      await rm(dataDir2, { recursive: true, force: true });
    }
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
          content: '{"name":"widget","scripts":{"start":"bun run server.ts"}}\n',
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
});

describe("the studio home does not wait on the decider", () => {
  const DECIDER_MS = 800;
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let repo: Repo;
  let cookie: string;
  let calls: number;

  const get = (path: string) =>
    fetch(`${base}${path}`, {
      headers: { cookie: `${cookie}; forge_mode=studio` },
      redirect: "manual",
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-studio-lean-"));
    calls = 0;
    const decider: Decider = {
      name: "slow",
      async decide(_state, questions) {
        calls++;
        await Bun.sleep(DECIDER_MS);
        const options = questions["option"]!.options;
        return {
          option: {
            choice: options[0]!,
            p: 0.9,
            probabilities: Object.fromEntries(
              options.map((o, i) => [o, i === 0 ? 0.9 : 0.05]),
            ),
          },
        } as never;
      },
    };
    app = createApp({ dataDir, port: 0, decider });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, {
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
      name: "leans",
      visibility: "private",
      description: "for the lean",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [
        {
          path: "package.json",
          content: '{"name":"leans","scripts":{"start":"bun run server.ts"}}\n',
        },
        {
          path: "server.ts",
          content:
            "Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('ok') });\n",
        },
      ],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, alice, repo, { slug: "leans" });
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
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("answers well under the decider's own time, with no call made while rendering, and the second render carries the lean the first one asked for", async () => {
    const started = Date.now();
    const home = await (await get("/")).text();
    expect(Date.now() - started).toBeLessThan(DECIDER_MS / 2);
    expect(calls).toBe(0);
    expect(home).toContain("Ship");
    expect(home).not.toContain("by the decider");
    await pendingLeans();
    expect(calls).toBe(1);
    const again = await (await get("/")).text();
    expect(again).toContain("by the decider");
  });
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
    const a = await createUser(app.db, {
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

  test("Asks you, Your apps, Happening now and On you are each a live region, with the security floor's headers", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    const home = await res.text();
    expect(home).toMatch(/id="live-asks"\s+data-live="/);
    expect(home).toMatch(/id="live-apps"\s*\n?\s*data-live="/);
    expect(home).toMatch(/id="live-now"\s+data-live="/);
    expect(home).toMatch(/id="live-on-you"\s*\n?\s*data-live="/);
    expect(home).toContain("new EventSource('/events')");
    expect(home).toContain("Add x");
    expect(home).toContain("Write the README");
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

  test("a card leaves Asks you and Your apps once its pull merges; On you once its issue closes", async () => {
    const before = await (await get()).text();
    expect(before).toContain("Add x");
    expect(before).toContain("Write the README");

    const merged = await mergePull(app, alice, repo, pull, "squash");
    expect(merged.ok).toBe(true);
    expect(setIssueState(app, alice, repo, readme, "closed").ok).toBe(true);

    const after = await (await get()).text();
    expect(after).not.toContain("Add x");
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
    readonly lastError?: string;
    readonly lastRunId?: string;
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
    const a = await createUser(app.db, {
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    const b = await createUser(app.db, {
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

  test("a failed production says what failed, links its deploy, and offers Redeploy to a writer only", async () => {
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

    const theirs = await head(reader);
    expect(theirs).toContain("not up");
    expect(theirs).toContain("the deploy failed: &lt;install&gt; exited 1");
    expect(theirs).toContain(`href="/alice/notes/runs/${deploy}"`);
    expect(theirs).not.toContain("/app/production/redeploy");
    expect(theirs).not.toContain("/app/production/stop");
  });

  test("a stopped production says it is not running and offers Redeploy, not Stop", async () => {
    put({ lastRunId: deploy });
    const mine = await head(writer);
    expect(mine).toContain("not running");
    expect(mine).toContain('action="/alice/notes/app/production/redeploy"');
    expect(mine).not.toContain('action="/alice/notes/app/production/stop"');
  });

  test("a serving app with red tests still reads as serving, with the failure in its own words", async () => {
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
    app.config.sshHostKey = "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    servers = await serve(app);
    base = servers.url;
    runtime = new AppsRuntime(app, {
      domain: "apps.test",
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
    const b = await createUser(app.db, {
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
    expect(mine).toContain(
      "host key SHA256:abcdefghijklmnopqrstuvwxyz",
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
    const a = await createUser(app.db, {
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    const c = await createUser(app.db, {
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

  test("the head measures from the push, not from the permit it waited for: a deploy queued 5s reads 6.0s after the push and names the wait", async () => {
    const createdAt = new Date(Date.now() - 20_000).toISOString();
    const deployStartedAt = new Date(Date.parse(createdAt) + 5_000).toISOString();
    const servingAt = new Date(Date.parse(deployStartedAt) + 1_000).toISOString();
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
    const a = await createUser(app.db, {
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

  const put = (
    live?: { commitOid: string; state?: "failed" },
  ): void => {
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
    const a = await createUser(app.db, {
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

  test('an agent run that opened no pull and pushed nothing is not shipped', async () => {
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
    const word = await pullWord(wordCtx, getPull(app.db, repo.id, pull.number)!);
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
    const a = await createUser(app.db, {
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const b = await createUser(app.db, {
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
    expect(page).toContain(`href="/alice/engine/issues/${tell.value.number}"`);
    expect(page).toContain("$0.42 spent");
    expect(page).toContain('data-word="working"');
    expect(page).toContain('id="run-steer"');
    expect(page).toContain("Steer scout");
    expect(page).toContain('id="run-stop"');
    // The transcript is on the page, and dev's own reading is one click away.
    expect(page).toContain('id="run-log"');
    expect(page).toContain(`href="/alice/engine/runs/${run.id}?mode=dev"`);
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
    expect(page).toContain('data-word="look"');
    expect(page).not.toContain('id="run-stop"');
    expect(page).not.toContain(">Stop<");
    expect(page).not.toContain(">Cancel run<");
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
        cookie: cookie === undefined ? "forge_mode=studio" : `${cookie}; forge_mode=studio`,
      },
      redirect: "manual",
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-studio-public-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, {
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const c = await createUser(app.db, {
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
    }

    expect(owner).toContain("$42.50");
    expect(owner).toContain("keeper");
    expect(owner).toContain(">On its own<");
    expect(owner).toContain(">Decided<");
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
    expect(tailAsStranger).not.toContain("42.5");
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

  test("the studio's settings page renders the crew and the ceiling for a writer, with the same numbers the app page shows", async () => {
    const owner = await (await get("/alice/beacon/settings", ownerCookie)).text();
    expect(owner).toContain("keeper");
    expect(owner).toContain(">Crew<");
    expect(owner).toContain(">On its own<");
    expect(owner).toMatch(/\$42\.50\s+of\s+\$25/);
    expect(owner).toContain("Remove");
    expect(owner).toContain("Save");
    expect(owner).toContain("The rest of the settings");
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
      "/alice/beacon/settings/crew",
    );
    const after = await (
      await get("/alice/beacon/settings", ownerCookie)
    ).text();
    expect(after).toContain("reviews");
  });

  test("?mode=dev on the settings route still renders dev's settings pages", async () => {
    const dev = await (
      await get("/alice/beacon/settings?mode=dev", ownerCookie)
    ).text();
    expect(dev).toContain(">General<");
    expect(dev).toContain("Description");
    expect(dev).not.toContain("Add to crew");
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
    expect(servedPhrase(env({ servingAt: "2026-01-01T00:00:02.500Z" }))).toBeUndefined();
    expect(
      servedPhrase(
        env({ createdAt: "not a time", servingAt: "2026-01-01T00:00:02.500Z" }),
      ),
    ).toBeUndefined();
  });
});
