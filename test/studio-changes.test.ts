/**
 * The studio: one signed-in owner's lists and change pages, tells and
 * doors. One of the files the studio's suite was split into so no one file
 * sets the gate's floor (#2038); the rest are test/studio*.test.ts. One forge
 * and one git fixture are built once for the file and nothing waits on a
 * clock, so the file runs in about 2 s (#3575).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { enableApp } from "../src/actions/apps.ts";
import { getAppByRepo } from "../src/core/apps.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import {
  assignIssue,
  openIssue,
  setIssueLabels,
  setIssueState,
} from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import {
  commitToBranch,
  createLabel,
  createRepo,
} from "../src/actions/repos.ts";
import { recordLook } from "../src/core/looks.ts";
import { setDirectionIssue, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { PNG, serving } from "./helpers/studio.ts";
import { promote } from "./helpers/members.ts";

describe("the studio, continued", () => {
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
    promote(app.db, a.value);
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
    expect(anon).toContain('<details class="disclosure mt">');
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

  test("the three studio lists carry one header, and only the issue list offers Not started (#175)", async () => {
    const issues = await (await get("/alice/notes/issues")).text();
    const pulls = await (await get("/alice/notes/pulls")).text();
    const runs = await (await get("/alice/notes/runs")).text();
    // The same header on all three: the description, not the compact one.
    for (const page of [issues, pulls, runs])
      expect(page).toContain('<p class="muted small">a place for notes</p>');
    // No pull and no run is ever told, so only the issue list links to it.
    expect(issues).toContain('href="/alice/notes/issues?word=told"');
    expect(pulls).not.toContain("word=told");
    expect(runs).not.toContain("word=told");
    for (const page of [pulls, runs]) expect(page).not.toContain("Not started");
    // A URL somebody holds still answers, never an error.
    expect((await get("/alice/notes/pulls?word=told")).status).toBe(200);
    expect((await get("/alice/notes/runs?word=told")).status).toBe(200);
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
    expect(page).not.toMatch(/class="[^"]*\bfilters\b/);
    expect(page).toContain("Not started");

    const filtered = await (await get("/alice/notes/issues?word=told")).text();
    expect(filtered).toContain("List test: not picked up yet");
    const other = await (await get("/alice/notes/issues?word=shipped")).text();
    expect(other).not.toContain("List test: not picked up yet");

    // There is no second list behind the mode: the cookie and the escape
    // hatch both answer the same rows in the same words.
    for (const dev of [
      await get("/alice/notes/issues", { cookie: `${cookie}; forge_mode=dev` }),
      await get("/alice/notes/issues"),
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
      await get("/alice/notes/pulls"),
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
      await get("/alice/notes/runs?word=stopped"),
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
    expect(deploys).toContain('href="/alice/notes/runs?kind=deploy&amp;word=stopped"');
  });

  test("the runs list shows agent runs, checks and deploys together, and each kind link narrows it", async () => {
    const scout = getUserByName(app.db, "scout")!;
    const mk = (kind: "agent" | "check" | "deploy") => {
      const run = createRun(app.db, {
        repoId: repo.id,
        kind,
        actorId: kind === "agent" ? scout.id : undefined,
        reason: "push",
        commitOid: "abcdef1234567890abcdef1234567890abcdef12",
      });
      claimRun(app.db, run.id);
      finishRun(app.db, run.id, { state: "ok", summary: "fine" });
      return `href="/alice/notes/runs/${run.id}"`;
    };
    const agent = mk("agent");
    const check = mk("check");
    const deploy = mk("deploy");

    const all = await (await get("/alice/notes/runs")).text();
    for (const link of [agent, check, deploy]) expect(all).toContain(link);
    expect(all).toContain("Check of abcdef1");
    // A row is title, state word and time (#10415): no sha, no duration beside it.
    expect(all).not.toContain("abcdef1 · passed");
    expect(all).toContain("<time");
    const checkId = /runs\/([^"]+)"/.exec(check)![1];
    expect(await (await get(`/alice/notes/runs/${checkId}`)).text()).toContain("abcdef1");

    const only = async (kind: string) =>
      (await get(`/alice/notes/runs?kind=${kind}`)).text();
    const a = await only("agent");
    expect(a).toContain(agent);
    expect(a).not.toContain(check);
    expect(a).not.toContain(deploy);
    const c = await only("check");
    expect(c).toContain(check);
    expect(c).not.toContain(agent);
    expect(c).not.toContain(deploy);
    const d = await only("deploy");
    expect(d).toContain(deploy);
    expect(d).not.toContain(agent);
    expect(d).not.toContain(check);
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
      // A plain repository speaks of issues: an untouched one reads "open",
      // and neither Told nor Look is a filter there (#683 follow-up).
      expect(issues).toMatch(/data-word="told"[^>]*aria-label="open\b/);
      expect(issues).toContain(`href="/alice/plainlists/issues?word=working"`);
      expect(issues).not.toContain(`href="/alice/plainlists/issues?word=told"`);
      expect(issues).not.toContain(`href="/alice/plainlists/issues?word=look"`);
      expect(issues).toContain(
        `href="/alice/plainlists/issues/${told.value.number}"`,
      );
      expect(issues).not.toContain("See dev's list");

      const pulls = await (
        await get("/alice/plainlists/pulls", { cookie: viewer })
      ).text();
      expect(pulls).toContain(`href="/alice/plainlists/pulls?word=working"`);
      expect(pulls).not.toContain(`href="/alice/plainlists/pulls?word=look"`);
      expect(pulls).not.toContain("See dev's list");
    }

    const runs = await (await get("/alice/plainlists/runs")).text();
    expect(runs).toContain(`href="/alice/plainlists/runs?word=working"`);
    expect(runs).not.toContain("See dev's list");
  });

  test("the issues and pulls lists of an app filter by word, and their self-links stay on their own address", async () => {
    const told = openIssue(app, alice, repo, {
      title: "Door test: a tell",
      body: "reached through /issues",
    });
    if (!told.ok) throw new Error(String(told.error));

    const viaIssues = await (await get("/alice/notes/issues")).text();
    expect(viaIssues).toContain("Door test: a tell");
    expect(viaIssues).toContain('data-word="told"');
    expect(viaIssues).toContain(`href="/alice/notes/issues?word=told"`);

    const filtered = await (await get("/alice/notes/issues?word=told")).text();
    expect(filtered).toContain("Door test: a tell");
    const other = await (await get("/alice/notes/issues?word=shipped")).text();
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
    expect(viaPulls).toContain("Door test: a change");
    expect(viaPulls).toContain('data-word="look"');
    expect(viaPulls).toContain(`href="/alice/notes/pulls?word=look"`);

    const changeFiltered = await (
      await get("/alice/notes/pulls?word=look")
    ).text();
    expect(changeFiltered).toContain("Door test: a change");
    const changeOther = await (
      await get("/alice/notes/pulls?word=shipped")
    ).text();
    expect(changeOther).not.toContain("Door test: a change");
    // A green pull left open now asks the front door too (#208) — close it
    // so it does not linger into a later test's own count of asks.
    expect(setIssueState(app, alice, repo, doorPull, "closed").ok).toBe(true);
  });

  test("/tells and /changes answer every viewer, app or not, with the same 301 to /issues and /pulls (#3241)", async () => {
    const plain = await createRepo(app, alice, {
      name: "doorlists",
      visibility: "private",
      description: "no app here",
    });
    if (!plain.ok) throw new Error(String(plain.error));

    for (const [path, viewer] of [
      ["/alice/notes/tells", `${cookie}; forge_mode=dev`],
      ["/alice/notes/changes", `${cookie}; forge_mode=dev`],
      ["/alice/notes/tells", `${cookie}; forge_mode=studio`],
      ["/alice/doorlists/tells", cookie],
      ["/alice/doorlists/changes", cookie],
    ] as const) {
      const res = await get(path, { cookie: viewer });
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe(
        path.replace(/\/tells$/, "/issues").replace(/\/changes$/, "/pulls"),
      );
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
    expect(labelled).toContain(`href="/alice/facetlists/issues?word=working&amp;label=bug"`);

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
    // The older address's narrowing is shown, and clears itself.
    expect(closed).toContain("closed ✕");
    expect(closed).toMatch(/href="\/alice\/facetlists\/issues"\s+aria-current="true"/);
    expect(
      await (await get("/alice/facetlists/issues?state=all")).text(),
    ).toContain("open and closed ✕");
    // Closed with nothing merged is not dropped from the list: it reads
    // done, under shipped, where whoever closed it would look.
    const shipped = await (await get("/alice/facetlists/issues?word=shipped")).text();
    expect(shipped).toContain("Facet: long done");
    expect(shipped).toContain('data-word="done"');
    const all = await (await get("/alice/facetlists/issues?state=all")).text();
    expect(all).toContain("Facet: long done");
    expect(all).toContain("Facet: a wish");
  });

  test("a plain repository's pages promise no deploy and say issue: an open change waits on a person, an issue closes as an issue, and only its author or a writer may close it", async () => {
    const plain = await createRepo(app, alice, {
      name: "plainwords",
      visibility: "public",
      description: "",
    });
    if (!plain.ok) throw new Error(String(plain.error));
    const seeded = await commitToBranch(app, alice, plain.value, {
      message: "Start",
      files: [{ path: "README.md", content: "hi\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const branch = await commitToBranch(app, alice, plain.value, {
      branch: "plain-change",
      base: "main",
      message: "Plain change",
      files: [{ path: "PLAIN.md", content: "x\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, plain.value, {
      title: "A plain change",
      body: "",
      baseBranch: "main",
      headBranch: "plain-change",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const changes = await (await get("/alice/plainwords/pulls")).text();
    expect(changes).toContain("open — waiting on a person");
    expect(changes).not.toContain("no deploy of this head yet");

    const told = openIssue(app, alice, plain.value, { title: "A plain issue" });
    if (!told.ok) throw new Error(String(told.error));
    const at = `/alice/plainwords/issues/${told.value.number}`;
    const own = await (await get(at)).text();
    expect(own).toContain("Close issue");
    expect(own).not.toContain("Close tell");
    expect(own).toContain(`action="${at}/state"`);

    // A signed-in stranger may comment on a public issue, never close it.
    const stranger = await createUser(app.db, { origin: "seed", trusted: true,
      username: "plainstranger",
      email: "plainstranger@forge.local",
      password: "a-good-passphrase",
    });
    if (!stranger.ok) throw new Error(stranger.error);
    promote(app.db, stranger.value);
    const strangerCookie = (
      (
        await fetch(`${base}/signin`, {
          method: "POST",
          body: new URLSearchParams({
            username: "plainstranger",
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
    expect(seen).not.toContain("Close issue");

    // Signed out on a public repository: the way in is offered.
    const anon = await (
      await fetch(`${base}/alice/plainwords/issues`, { redirect: "manual" })
    ).text();
    expect(anon).toContain("Sign in to open an issue");
    expect(anon).toContain("Report a problem</a");
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

  test("a reader without access who follows /tells or /changes lands on the forge's not-found, exactly as /issues and /pulls", async () => {
    const anonTells = await fetch(`${base}/alice/notes/tells`, {
      headers: { cookie: "forge_mode=studio" },
    });
    expect(anonTells.status).toBe(404);

    const anonChanges = await fetch(`${base}/alice/notes/changes`, {
      headers: { cookie: "forge_mode=studio" },
    });
    expect(anonChanges.status).toBe(404);
  });

  test("/issues/:number and /pulls/:number are an app's issue and pull request pages, and every studio surface links there", async () => {
    const told = openIssue(app, alice, repo, {
      title: "Door test: one tell",
      body: "reached through /issues/:number",
    });
    if (!told.ok) throw new Error(String(told.error));
    const n = told.value.number;

    const viaTell = await get(`/alice/notes/issues/${n}`);
    expect(viaTell.status).toBe(200);
    const tellHtml = await viaTell.text();
    expect(tellHtml).toContain("Door test: one tell");
    expect(tellHtml).toContain('data-word="told"');
    // Still waiting: the state word says so; the page adds no second line (#10415).
    expect(tellHtml).not.toContain("nobody has it yet");
    // The reply, the close and every Details form post to /issues/:number.
    expect(tellHtml).toContain(`action="/alice/notes/issues/${n}/comments"`);
    expect(tellHtml).toContain(`action="/alice/notes/issues/${n}/assignee"`);
    // An anchor into the conversation lands on the composer.
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

    const viaChange = await get(`/alice/notes/pulls/${p}`);
    expect(viaChange.status).toBe(200);
    const changeHtml = await viaChange.text();
    expect(changeHtml).toContain("Door test: one change");
    // The studio's change, not dev's diff.
    expect(changeHtml).not.toContain("diff-table");
    expect(changeHtml).toContain(`action="/alice/notes/pulls/${p}/comments"`);
    expect(changeHtml).toContain(`href="/alice/notes/pulls/${p}/files"`);
    expect(changeHtml).toContain('id="comment-body"');
    expect(changeHtml).toContain('class="page-head"');
    expect(changeHtml).toContain('class="page-head-sub bar muted small"');
    expect(changeHtml).not.toContain("issue-head");
    expect(changeHtml).not.toContain("issue-meta");
    // The tabs are §5's bar, not the retired .filters wrapper.
    expect(changeHtml).not.toMatch(/class="[^"]*\bfilters\b/);
    expect(changeHtml).toContain("Conversation");

    // The lists, the app page and the search box all hand out the one
    // address, so a person is never given two addresses for one thing.
    const tells = await (await get("/alice/notes/issues")).text();
    expect(tells).toContain(`href="/alice/notes/issues/${n}"`);
    const changes = await (await get("/alice/notes/pulls")).text();
    expect(changes).toContain(`href="/alice/notes/pulls/${p}"`);
    const appPage = await (await get("/alice/notes")).text();
    expect(appPage).toContain(`href="/alice/notes/pulls/${p}"`);
    expect(appPage).not.toMatch(/href="[^"]*\/(tells|changes)\//);
    const search = await (await get("/search?q=Door+test")).text();
    expect(search).toContain(`/alice/notes/issues/${n}`);
    expect(search).toContain(`/alice/notes/pulls/${p}`);
    expect(search).not.toMatch(/\/alice\/notes\/(tells|changes)\//);
  });

  test("/tells/:number answers every viewer, app or not, with the same 301 to /issues/:number (#3241)", async () => {
    const told = openIssue(app, alice, repo, { title: "Door test: dev's way" });
    if (!told.ok) throw new Error(String(told.error));
    const n = told.value.number;

    for (const res of [
      await get(`/alice/notes/tells/${n}`, {
        cookie: `${cookie}; forge_mode=dev`,
      }),
      await get(`/alice/notes/tells/${n}`),
    ]) {
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe(`/alice/notes/issues/${n}`);
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
    expect(plainTell.status).toBe(301);
    expect(plainTell.headers.get("location")).toBe(
      `/alice/doorpages/issues/${plainTold.value.number}`,
    );
  });

  test("a reader without access who follows /tells/:number or /changes/:number lands on the forge's not-found, exactly as /issues/:number and /pulls/:number", async () => {
    const told = openIssue(app, alice, repo, { title: "Door test: private" });
    if (!told.ok) throw new Error(String(told.error));
    const n = told.value.number;

    const anonTell = await fetch(`${base}/alice/notes/tells/${n}`, {
      headers: { cookie: "forge_mode=studio" },
    });
    expect(anonTell.status).toBe(404);
    const anonIssue = await fetch(`${base}/alice/notes/issues/${n}`, {
      headers: { cookie: "forge_mode=studio" },
      redirect: "manual",
    });
    expect(anonIssue.status).toBe(anonTell.status);

    // A number that is not a tell is not a tell at either address, and a
    // change's number is not one under the tell's own noun.
    const missing = await get("/alice/notes/issues/99999");
    expect(missing.status).toBe(404);
    const anonChange = await fetch(`${base}/alice/notes/changes/1`, {
      headers: { cookie: "forge_mode=studio" },
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
    const bob = await createUser(app.db, { origin: "seed", trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!bob.ok) throw new Error(bob.error);
    promote(app.db, bob.value);
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
      await bobGet("/apps"),
    ]) {
      const text = await dev.text();
      expect(text).toContain('href="/apps?live=1"');
      expect(text).not.toContain('href="/alice/notes"');
      expect(text).not.toContain("Repositories that run.");
    }
  });

  test("clicking your own name lands on /:owner, which leads with your apps on the shelf and New app as the primary action, in every mode; a stranger never sees a private one", async () => {
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
    // One owner page (#633): the cookie changes nothing.
    expect(dev).toContain("<h2>Apps</h2>");
    expect(dev).toContain('href="/apps/new?owner=alice"');
    expect(dev).toContain("not running");

    const carol = await createUser(app.db, { origin: "seed", trusted: true,
      username: "carol",
      email: "carol@forge.local",
      password: "a-good-passphrase",
    });
    if (!carol.ok) throw new Error(carol.error);
    promote(app.db, carol.value);
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
    // Nothing to see is shown as nothing: no empty apps card for a visitor.
    expect(stranger).not.toContain("No apps yet");
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
    expect(dev).toContain("Software for what you");
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
    const erin = await createUser(app.db, { origin: "seed", trusted: true,
      username: "erin",
      email: "erin@forge.local",
      password: "a-good-passphrase",
    });
    if (!erin.ok) throw new Error(erin.error);
    promote(app.db, erin.value);
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
    const erinHome = await (await erinGet("/feed")).text();
    expect(erinHome).toContain("No apps yet");
    expect(erinHome).toContain('href="/apps/new"');
    expect(erinHome).toContain('href="/erin"');
    expect(erinHome).not.toContain("/?mode=dev");
    expect(erinHome).not.toContain('href="/alice/lighthouse"');
    expect(erinHome).not.toContain("tell the crew something");
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
      const owner = await createUser(app2.db, { origin: "seed", trusted: true,
        username: "olga",
        email: "olga@forge.local",
        password: "a-good-passphrase",
      });
      if (!owner.ok) throw new Error(owner.error);
      promote(app2.db, owner.value);
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
        ["/", ""],
        ["/", "forge_mode=dev"],
      ] as const) {
        const response = await fetch(`${servers2.url}${path}`, {
          headers: { cookie },
          redirect: "manual",
        });
        expect(response.status).toBe(200);
        const body = await response.text();
        expect(body).toContain("Software for what you");
        expect(body).toContain("Nothing public is up yet");
        expect(body).toContain('href="/signup"');
        expect(body).toContain('href="/signin"');
        expect(body).not.toContain("terminal is off");
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
      const made = await createUser(app2.db, { origin: "seed", trusted: true,
        username: "pia",
        email: "pia@forge.local",
        password: "a-good-passphrase",
      });
      if (!made.ok) throw new Error(made.error);
      promote(app2.db, made.value);
      app2.db.query(`UPDATE user SET is_admin = 1 WHERE id = ?1`).run(made.value.id);
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

    const list = await (await get("/alice/notes/pulls")).text();
    const rowOf = (title: string) => {
      const at = list.indexOf(title);
      return list.slice(at, list.indexOf("</a>", at + 400) + 4);
    };
    // The calm pass (#10415): a row is title, word and time; the tell it answers is on the pull.
    for (const title of ["Answers the tell", "Answers nothing", "A person's branch"]) {
      expect(rowOf(title.replace("'", "&#39;"))).toContain("<time");
      expect(rowOf(title.replace("'", "&#39;"))).not.toContain("for issue");
    }
    expect(rowOf("Answers the tell")).toContain('data-word=');
    expect(
      await (await get(`/alice/notes/pulls/${answering.number}`)).text(),
    ).toContain(`href="/alice/notes/issues/${n}"`);

    setIssueState(app, alice, repo, told.value, "closed");
    const closedList = await (await get("/alice/notes/pulls")).text();
    expect(closedList).not.toContain("its issue is already done");
    const page = await (
      await get(`/alice/notes/pulls/${answering.number}`)
    ).text();
    expect(page).toContain(`href="/alice/notes/issues/${n}"`);
    expect(page).toContain("its issue is already done");
    for (const p of [stray, own]) {
      const res = await get(`/alice/notes/pulls/${p.number}`);
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain("for issue");
    }
  });
});
