/**
 * The studio: what a stranger sees, shipping and taking back a change, the
 * crew panel, and the week's counts. One of the files the studio's suite
 * was split into so no one file sets the gate's floor (#2038); the rest are
 * test/studio*.test.ts.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { enableApp } from "../src/actions/apps.ts";
import type { EnvStatus } from "../src/apps/runtime.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { addTeamMember, createOrg, createTeam } from "../src/actions/orgs.ts";
import { openIssue } from "../src/actions/issues.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import {
  commitToBranch,
  createRepo,
  updateRepoSettings,
} from "../src/actions/repos.ts";
import { recordDecision } from "../src/core/decisions.ts";
import { getPull, mergedPullCount, type Pull } from "../src/core/pulls.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import {
  agentRunTotals,
  claimRun,
  createRun,
  finishRun,
  markServing,
  previewLatency,
  STOPPED_SUMMARY,
  type Run,
} from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { NOBODY_ON_CREW } from "../src/web/studio/words.ts";
import { servedPhrase } from "../src/web/ui.ts";
import { ageApp } from "./helpers/history.ts";

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
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const c = await createUser(app.db, { origin: "seed", trusted: true,
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
      expect(page).not.toContain("/fleet/graph");
      expect(page).not.toContain(">Slots<");
      expect(page).not.toContain("Nobody yet");
      // The app itself is still there: what it is, that it shipped, a way in.
      expect(page).toContain("a light that stays on");
      expect(page).toContain(">Shipped<");
      expect(page).toContain("1 pull request");
      expect(page).toContain("Open the app");
      // The direction's own number is the same owner's-books fact as spend
      // and the ledger: a stranger and an anonymous visitor see neither.
      expect(page).not.toContain(">Preview<");
      expect(page).not.toContain("reaches its preview");
    }

    expect(owner).toContain("$42.50");
    expect(owner).toContain("keeper");
    expect(owner).toContain(">On its own<");
    // One click from the app's spend to the fleet graph, scoped to this app (#578).
    expect(owner).toContain('href="/fleet/graph?repo=alice%2Fbeacon"');
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
      // The log box, which carried data-who, is not drawn for them (#1075).
      expect(page).toContain("<title>the crew on #");
      expect(page).not.toContain('id="run-log"');
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

    // The log is the writers' and crew's (#1075): a stranger's tail is
    // refused, and carries neither the cost nor the transcript.
    const tailAsStranger = await get(
      `/api/v1/repos/alice/beacon/runs/${run.id}/log?follow=1`,
      strangerCookie,
    );
    expect(tailAsStranger.status).toBe(404);
    expect(await tailAsStranger.text()).not.toContain("42.5");
    const tailAsOwner = await (
      await get(
        `/api/v1/repos/alice/beacon/runs/${run.id}/log?follow=1`,
        ownerCookie,
      )
    ).text();
    expect(tailAsOwner).toContain("42.5");
  });

  test("the studio home names the crew for the owner, but only 'the crew' for a signed-in reader of the same public app", async () => {
    const asStranger = await (await get("/apps", strangerCookie)).text();
    expect(asStranger).not.toContain("keeper");
    expect(asStranger).toContain("beacon");
    const asOwner = await (await get("/apps", ownerCookie)).text();
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

    // An older app: a new one shows only its progress (#10299).
    ageApp(app.db, lamp.id);
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
    // The crew card says the governor's reason in one line (#7644).
    expect(owner).toMatch(/<dt>Governor<\/dt>\s*<dd>Builders \d+: /);
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

  test("each settings card saves only its own fields: About never turns a gate or the outsiders switch off, and Branch and gates never touches the words", async () => {
    const before = getRepo(app.db, "alice", "beacon")!;
    const on = await post(
      "/alice/beacon/settings",
      {
        card: "gates",
        defaultBranch: before.defaultBranch,
        protect: "on",
        requireReview: "on",
        // The settings page sends this marker beside the switch; without it a
        // save leaves the switch as it is (#822).
        crewOutsidersShown: "1",
        crewOutsiders: "on",
      },
      ownerCookie,
    );
    expect(on.status).toBe(303);
    let now = getRepo(app.db, "alice", "beacon")!;
    expect(now.crewOutsiders).toBe(true);
    expect(now.description).toBe(before.description);

    const about = await post(
      "/alice/beacon/settings",
      { card: "about", description: "a lamp", visibility: now.visibility },
      ownerCookie,
    );
    expect(about.status).toBe(303);
    now = getRepo(app.db, "alice", "beacon")!;
    expect(now.description).toBe("a lamp");
    expect(now.crewOutsiders).toBe(true);
    expect(now.protectDefault).toBe(true);
    expect(now.requireReview).toBe(true);

    // Put it back for the tests that follow.
    await post(
      "/alice/beacon/settings",
      {
        card: "gates",
        defaultBranch: before.defaultBranch,
        crewOutsidersShown: "1",
      },
      ownerCookie,
    );
    await post(
      "/alice/beacon/settings",
      { card: "about", description: before.description, visibility: before.visibility },
      ownerCookie,
    );
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
    // Keeper declares only "builder", so the repository cannot widen it to
    // reviewer: it is drawn once, under the seat it holds — the team lists
    // are the crew, there is no second Crew card listing it again.
    const keeperRows = after.match(/<li[^>]*data-member="keeper"[^>]*>/g) ?? [];
    expect(keeperRows).toEqual(['<li data-member="keeper" data-seat="builder">']);
    expect(after).not.toContain("<h2>Crew</h2>");
  });

  test("?mode=dev on the settings route is the same one page; dev's Crew and Autonomy addresses land on its cards", async () => {
    const dev = await (
      await get("/alice/beacon/settings", ownerCookie)
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
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const r = await createUser(app.db, { origin: "seed", trusted: true,
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
    expect(readerPage).not.toContain(`id="decide"`);
    expect(readerPage).not.toContain("Ship");

    const ownerPage = await (
      await get(`/alice/garden/pulls/${pull.number}`, ownerCookie)
    ).text();
    expect(ownerPage).toContain(`id="decide"`);
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
    expect(studio).toContain(`id="decide"`);
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
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const r = await createUser(app.db, { origin: "seed", trusted: true,
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
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    const alice = a.value;
    const b = await createUser(app.db, { origin: "seed", trusted: true,
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

  test("the app page's way to add a crew member leads unbroken to the door an agent is made through, with nothing dev-only in the way", async () => {
    const appPage = await (await get("/alice/pad", ownerCookie)).text();
    expect(appPage).toContain("Nobody on the crew yet");
    expect(appPage).toContain('href="/alice/pad/settings#crew"');

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
    const a = await createUser(app.db, { origin: "seed", trusted: true,
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

  // Each test reads only the deploys it seeds: the window has no upper
  // bound, so another test's deploys would otherwise land in it.
  beforeEach(() => {
    app.db.query("DELETE FROM run WHERE repo_id = ?1").run(repo.id);
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
    const now = Date.now();
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
    const now = Date.now();
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
    const now = Date.now();
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
    const now = Date.now();
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
    const a = await createUser(app.db, { origin: "seed", trusted: true,
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

  // Each test reads only the deploys it seeds; the agent run from
  // beforeAll stays, so the page always has history behind it.
  beforeEach(() => {
    app.db
      .query("DELETE FROM run WHERE repo_id = ?1 AND kind = 'deploy'")
      .run(repo.id);
  });

  const get = (path: string) =>
    fetch(`${base}${path}`, {
      headers: { cookie: `${ownerCookie}; forge_mode=studio` },
      redirect: "manual",
    });

  /** A deploy run stamped with a known push instant and serving instant, and unless null a known started instant. */
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
    // Four served deploys first, so the failed one is the fifth.
    const now = Date.now();
    for (let i = 0; i < 4; i++) {
      seedDeploy(
        new Date(now + i * 1_000).toISOString(),
        null,
        new Date(now + i * 1_000 + 5_000).toISOString(),
      );
    }
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
    const a = await createUser(app.db, { origin: "seed", trusted: true,
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
    const a = await createUser(app.db, { origin: "seed", trusted: true,
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
    const a = await createUser(app.db, { origin: "seed", trusted: true,
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
    expect(page).toMatch(/Shipped<\/dt>\s*<dd>150 pull requests<\/dd>/);
    expect(page).not.toContain("100 pull requests");
    // And the cost of a shipped change divides by all 150.
    expect(page).toContain(
      `$${(SPENT / SHIPPED).toFixed(2)} per shipped pull request`,
    );
  });

  test("an app with real history but nothing shipped this week reads 0 changes and no cost per change", async () => {
    const page = await (await get("/alice/quiet")).text();
    expect(page).toMatch(/Shipped<\/dt>\s*<dd>0 pull requests<\/dd>/);
    expect(page).not.toContain("per shipped pull request");
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
    const a = await createUser(app.db, { origin: "seed", trusted: true,
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
    // A new app shows only its progress: no week, no rail (#10299).
    expect(page).not.toContain("This week");
    expect(page).not.toContain("Nothing to show yet");
    expect(page).toContain("Tell the crew");
    // Not a single zero from the old panel, and not the scary ratio: the
    // forge's own cancelled boot is never counted, and two deploys is well
    // under the threshold a ratio needs anyway.
    expect(page).not.toMatch(/Runs<\/dt>/);
    expect(page).not.toMatch(/Runs cost<\/dt>/);
    expect(page).not.toContain("never reached a preview");
    expect(page).not.toContain("$0.00");
  });

  test("a stranger sees the same quiet line, not the owner's zeros", async () => {
    const page = await (await fetch(`${base}/alice/newborn`)).text();
    expect(page).not.toContain("Nothing to show yet");
    expect(page).not.toMatch(/Shipped<\/dt>\s*<dd>0 pull requests<\/dd>/);
  });
});
