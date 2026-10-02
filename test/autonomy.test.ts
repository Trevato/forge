/**
 * A repository that runs on its own: the tick picks what is ready for a
 * builder, honours slots and the ceiling, asks the planner when the map has
 * run dry, and lands green pulls as the person who turned it on. Nothing
 * here starts a real agent; the crew is not running, so an assignment is
 * the observable effect.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import {
  commitToBranch,
  createRepo,
  updateRepoSettings,
} from "../src/actions/repos.ts";
import { setCrewRole } from "../src/core/agents.ts";
import { addDependency } from "../src/core/dependencies.ts";
import { getIssue, getIssueById, type Issue } from "../src/core/issues.ts";
import { getPull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun, listRuns } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import {
  autonomyStatus,
  driveRepo,
  landIfGreen,
  pickBuilder,
  sweepGreen,
  truncateAtWord,
} from "../src/crew/autonomy.ts";
import { MAX_TITLE } from "../src/core/issues.ts";

describe("truncateAtWord", () => {
  test("a direction that fits is passed through whole", () => {
    const text = "a".repeat(40);
    expect(truncateAtWord(text, 120)).toBe(text);
  });

  test("a direction that overflows is cut at a word boundary with an ellipsis", () => {
    const text = (
      "Make the studio the front door of the forge: a change is visible in its preview within seconds of each push (serve a deployed preview from every push and say so on the page) " +
      "and every direction the crew has ever been given keeps going on"
    ).slice(0, 200);
    expect(text.length).toBe(200);
    const cut = truncateAtWord(text, 120);
    expect(cut.length).toBeLessThanOrEqual(120);
    expect(cut.endsWith("…")).toBe(true);
    const withoutEllipsis = cut.slice(0, -1);
    expect(withoutEllipsis.endsWith(" ")).toBe(false);
    expect(withoutEllipsis.endsWith("(")).toBe(false);
    // The cut never falls inside a word: the character right after it in
    // the source text is a space, or the word ended there anyway.
    expect(text[withoutEllipsis.length]).toBe(" ");
  });

  test("Direction: plus the limit stays well under MAX_TITLE", () => {
    expect("Direction: ".length + 120).toBeLessThanOrEqual(MAX_TITLE);
  });
});

describe("a repository on its own", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let repo: Repo;
  let scout: User;
  let mason: User;
  let atlas: User;
  const issues: Issue[] = [];
  const fresh = () => getRepoById(app.db, repo.id)!;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-autonomy-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, {
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createRepo(app, alice, {
      name: "engine",
      visibility: "private",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# engine\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    for (const name of ["scout", "mason", "atlas"]) {
      const agent = await createAgent(app, alice, { username: name });
      if (!agent.ok) throw new Error(String(agent.error));
      expect(addToCrew(app, alice, repo, name).ok).toBe(true);
    }
    scout = (await import("../src/core/users.ts")).getUserByName(
      app.db,
      "scout",
    )!;
    mason = (await import("../src/core/users.ts")).getUserByName(
      app.db,
      "mason",
    )!;
    atlas = (await import("../src/core/users.ts")).getUserByName(
      app.db,
      "atlas",
    )!;
    setCrewRole(app.db, repo.id, atlas.id, "planner");
    for (const title of ["Renderer", "Input", "Scene graph"]) {
      const opened = openIssue(app, alice, repo, { title });
      if (!opened.ok) throw new Error(String(opened.error));
      issues.push(opened.value);
    }
    // Scene graph waits for the renderer; input is free.
    expect(addDependency(app.db, issues[2]!, issues[0]!, alice.id).ok).toBe(
      true,
    );
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("off does nothing; on, the widest-freeing ready issue goes to the freest builder", async () => {
    expect(await driveRepo(app, fresh())).toBe("off");
    const on = await updateRepoSettings(app, alice, repo, {
      autonomy: "autonomous",
      autonomyDirection: "Pull the engine out of the game.",
      autonomyCeilingUsd: 10,
      autonomySlots: 1,
      autonomyBy: alice.id,
    });
    expect(on.ok).toBe(true);
    expect(await driveRepo(app, fresh())).toBe("picked");
    // The renderer holds the scene graph up, so it goes first; with nothing
    // in flight the builders tie and mason sorts first by name.
    const renderer = getIssue(app.db, repo.id, 1)!;
    expect(renderer.assigneeId).toBe(mason.id);
    expect(getIssue(app.db, repo.id, 2)!.assigneeId).toBeNull();
  });

  test("slots are the WIP limit; a run in flight fills the one slot", async () => {
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: issues[0]!.id,
      actorId: mason.id,
      reason: "assigned",
    });
    claimRun(app.db, run.id);
    expect(await driveRepo(app, fresh())).toBe("full");
    // With two slots the next ready issue goes to the other builder.
    app.db
      .query("UPDATE repo SET autonomy_slots = 2 WHERE id = ?1")
      .run(repo.id);
    expect(await driveRepo(app, fresh())).toBe("picked");
    expect(getIssue(app.db, repo.id, 2)!.assigneeId).toBe(scout.id);
    finishRun(app.db, run.id, { state: "ok", summary: "done", costUsd: 4 });
  });

  test("the ceiling pauses picking until midnight and says so", async () => {
    const spent = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: issues[1]!.id,
      actorId: scout.id,
      reason: "assigned",
    });
    claimRun(app.db, spent.id);
    finishRun(app.db, spent.id, { state: "ok", summary: "done", costUsd: 7 });
    const status = autonomyStatus(app, fresh());
    expect(status.spentTodayUsd).toBeCloseTo(11, 5);
    expect(status.paused).toBe("ceiling");
    expect(status.resumesAt).not.toBeNull();
    expect(await driveRepo(app, fresh())).toBe("paused");
    app.db
      .query("UPDATE repo SET autonomy_ceiling_usd = 100 WHERE id = ?1")
      .run(repo.id);
    expect(autonomyStatus(app, fresh()).paused).toBeNull();
  });

  test("when the map runs dry the planner is given the direction, once", async () => {
    // Close everything: nothing ready, nothing in flight.
    const { setIssueState } = await import("../src/actions/issues.ts");
    for (const n of [1, 2, 3])
      expect(
        setIssueState(app, alice, repo, getIssue(app.db, repo.id, n)!, "closed")
          .ok,
      ).toBe(true);
    // The planner already holds the direction: the map went thin during
    // the picks above and planning started alongside building, before it
    // ran dry. A dry map with the planner on it is "idle", not asked again.
    expect(await driveRepo(app, fresh())).toBe("idle");
    const direction = getIssueById(app.db, fresh().directionIssueId!)!;
    expect(direction.title).toContain("Direction: Pull the engine out");
    expect(direction.assigneeId).toBe(atlas.id);
    // Asked, it is not asked again until the interval passes, and the
    // direction issue is never picked as work for a builder.
    expect(await driveRepo(app, fresh())).toBe("idle");
    const later = new Date(Date.now() + 7 * 60 * 60_000);
    expect(await driveRepo(app, fresh(), later)).toBe("idle");
    const planned = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: direction.id,
      actorId: atlas.id,
      reason: "assigned",
    });
    claimRun(app.db, planned.id);
    expect(await driveRepo(app, fresh(), later)).toBe("idle");
    finishRun(app.db, planned.id, {
      state: "ok",
      summary: "planned",
      costUsd: 1,
    });
    expect(await driveRepo(app, fresh())).toBe("idle");
    expect(await driveRepo(app, fresh(), later)).toBe("planned");
    expect(getIssueById(app.db, direction.id)!.assigneeId).toBe(atlas.id);
  });

  test("a green pull lands as the person who turned autonomy on; assisted leaves it", async () => {
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/physics",
      base: "main",
      message: "Physics step",
      files: [{ path: "physics.ts", content: "export const step = 1;\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "Physics step",
      baseBranch: "main",
      headBranch: "feature/physics",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    // No check yet: nothing to be green about.
    expect(await landIfGreen(app, fresh(), pull)).toBe(false);
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
    // Assisted: green waits for a look.
    app.db
      .query("UPDATE repo SET autonomy = 'assisted' WHERE id = ?1")
      .run(repo.id);
    expect(await landIfGreen(app, fresh(), pull)).toBe(false);
    app.db
      .query("UPDATE repo SET autonomy = 'autonomous' WHERE id = ?1")
      .run(repo.id);
    expect(await landIfGreen(app, fresh(), pull)).toBe(true);
    expect(getPull(app.db, repo.id, pull.number)?.mergedAt).not.toBeNull();
  });

  test("a green pull that no longer merges sends its agent one run to bring the branch up to date", async () => {
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/shared",
      base: "main",
      message: "Shared, the branch's way",
      files: [
        { path: "shared.ts", content: "export const shared = 'branch';\n" },
      ],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, atlas, repo, {
      title: "Shared",
      baseBranch: "main",
      headBranch: "feature/shared",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    // Main moves the other way on the same file.
    const moved = await commitToBranch(app, alice, repo, {
      branch: "main",
      message: "Shared, main's way",
      files: [
        { path: "shared.ts", content: "export const shared = 'main';\n" },
      ],
    });
    if (!moved.ok) throw new Error(JSON.stringify(moved.error));
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
    app.db
      .query("UPDATE repo SET autonomy = 'autonomous' WHERE id = ?1")
      .run(repo.id);

    expect(await landIfGreen(app, fresh(), pull)).toBe(false);
    const conflicts = () =>
      listRuns(app.db, repo.id, { kind: "agent" }).filter(
        (r) => r.issueId === pull.id && r.reason === "conflict",
      );
    expect(conflicts().length).toBe(1);
    expect(conflicts()[0]!.summary).toBe("main moved: shared.ts");
    expect(conflicts()[0]!.actorId).toBe(atlas.id);
    // Still not landed, still one run waiting: a second look queues nothing.
    expect(await landIfGreen(app, fresh(), pull)).toBe(false);
    expect(conflicts().length).toBe(1);
  });

  test("a merged pull closes what it says it closes; a proposed issue is not picked again; a stalled one waits for a person", async () => {
    app.db
      .query(
        "UPDATE repo SET autonomy = 'autonomous', autonomy_slots = 2 WHERE id = ?1",
      )
      .run(repo.id);
    const todo = openIssue(app, alice, repo, { title: "Audio mixer" });
    if (!todo.ok) throw new Error(String(todo.error));
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/audio",
      base: "main",
      message: "Audio mixer",
      files: [{ path: "audio.ts", content: "export const mix = 1;\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "Audio mixer",
      body: `Mixes.\n\nCloses #${todo.value.number}`,
      baseBranch: "main",
      headBranch: "feature/audio",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    // Proposed, so not ready for a builder: the tick has nothing to pick.
    expect(await driveRepo(app, fresh())).not.toBe("picked");
    expect(getIssue(app.db, repo.id, todo.value.number)!.assigneeId).toBeNull();

    // Green: the sweep lands it, and the issue it closes closes.
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
    expect(await sweepGreen(app, fresh())).toBe(1);
    expect(getIssue(app.db, repo.id, todo.value.number)!.state).toBe("closed");

    // A builder that ran and left no pull is stalled: not picked by the
    // clock, however ready the map says it is.
    const stuck = openIssue(app, alice, repo, { title: "Netcode" });
    if (!stuck.ok) throw new Error(String(stuck.error));
    const gaveUp = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: stuck.value.id,
      actorId: scout.id,
      reason: "assigned",
    });
    claimRun(app.db, gaveUp.id);
    finishRun(app.db, gaveUp.id, {
      state: "ok",
      summary: "no changes pushed: this needs a decision on the protocol",
      costUsd: 0.2,
    });
    expect(await driveRepo(app, fresh())).not.toBe("picked");
    expect(
      getIssue(app.db, repo.id, stuck.value.number)!.assigneeId,
    ).toBeNull();
  });

  test("the builder pick is one fixed-choice function", () => {
    const issue = { ...issues[1]!, assigneeId: null };
    const inFlight = new Map([[scout.id, 1]]);
    const scoutAgent = {
      user: scout,
      model: "",
      brief: "",
      budgetUsd: 0,
      createdBy: null,
      createdAt: "",
    };
    const masonAgent = {
      user: mason,
      model: "",
      brief: "",
      budgetUsd: 0,
      createdBy: null,
      createdAt: "",
    };
    expect(
      pickBuilder(issue, [scoutAgent, masonAgent], inFlight)?.user.username,
    ).toBe("mason");
    expect(
      pickBuilder(
        { ...issue, assigneeId: scout.id },
        [scoutAgent, masonAgent],
        inFlight,
      )?.user.username,
    ).toBe("scout");
    expect(pickBuilder(issue, [], inFlight)).toBeUndefined();
  });

  test("the settings page shows the mode and the crew page sets roles", async () => {
    const cookie = (
      (
        await fetch(`${servers.url}/signin`, {
          method: "POST",
          body: new URLSearchParams({
            username: "alice",
            password: "a-good-passphrase",
          }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
    const page = await (
      await fetch(`${servers.url}/alice/engine/settings/autonomy`, {
        headers: { cookie },
      })
    ).text();
    expect(page).toContain("Autonomous");
    expect(page).toContain("Planner here");
    const saved = await fetch(`${servers.url}/alice/engine/settings/autonomy`, {
      method: "POST",
      headers: { cookie, origin: servers.url },
      body: new URLSearchParams({
        autonomy: "assisted",
        direction: "Keep the engine small.",
        ceiling: "25",
        slots: "2",
      }),
      redirect: "manual",
    });
    expect(saved.status).toBe(303);
    const now = fresh();
    expect(now.autonomy).toBe("assisted");
    expect(now.autonomyCeilingUsd).toBe(25);
    expect(now.autonomyDirection).toBe("Keep the engine small.");
    const role = await fetch(
      `${servers.url}/alice/engine/settings/crew/mason/role`,
      {
        method: "POST",
        headers: { cookie, origin: servers.url },
        body: new URLSearchParams({ role: "reviewer" }),
        redirect: "manual",
      },
    );
    expect(role.status).toBe(303);
    const crew = await (
      await fetch(`${servers.url}/alice/engine/settings/crew`, {
        headers: { cookie },
      })
    ).text();
    expect(crew).toContain("reviewer");
    const map = await (
      await fetch(`${servers.url}/alice/engine/map`, { headers: { cookie } })
    ).text();
    expect(map).toContain("Assisted");
    expect(map).toContain("of $25 today");
  });

  test("the forge's own ceiling holds every repository, whatever each one's says", async () => {
    // A generous repository ceiling, a forge that has already spent its day.
    const on = await updateRepoSettings(app, alice, repo, {
      autonomy: "autonomous",
      autonomyDirection: "Keep going.",
      autonomyCeilingUsd: 1000,
      autonomySlots: 1,
      autonomyBy: alice.id,
    });
    expect(on.ok).toBe(true);
    const capped = { ...app, config: { ...app.config, crewCeilingUsd: 1 } };
    const spent = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      env: "",
      commitOid: "",
      reason: "assigned",
    });
    claimRun(app.db, spent.id);
    finishRun(app.db, spent.id, { state: "ok", summary: "done", costUsd: 2 });
    expect(autonomyStatus(capped, fresh()).paused).toBe("forge ceiling");
    expect(autonomyStatus(capped, fresh()).resumesAt).not.toBeNull();
    // Without the forge's ceiling the same repository runs on.
    expect(autonomyStatus(app, fresh()).paused).toBeNull();
  });
});

/**
 * One rule says which runs in flight spend a slot, and the number a page
 * shows is the number the loop gates on — never more than the slots.
 */
describe("the slot count is the rule the loop enforces", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let repo: Repo;
  let builder: User;
  let reviewer: User;
  let planner: User;
  const work: Issue[] = [];
  const fresh = () => getRepoById(app.db, repo.id)!;
  const running = (issue: Issue, actor: User, reason: string) => {
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: issue.id,
      actorId: actor.id,
      reason,
    });
    claimRun(app.db, run.id);
    return run;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-slots-"));
    app = createApp({ dataDir, port: 0 });
    const a = await createUser(app.db, {
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createRepo(app, alice, {
      name: "loom",
      visibility: "private",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# loom\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    for (const name of ["brick", "quill", "chart"]) {
      const agent = await createAgent(app, alice, { username: name });
      if (!agent.ok) throw new Error(String(agent.error));
      expect(addToCrew(app, alice, repo, name).ok).toBe(true);
    }
    const byName = (await import("../src/core/users.ts")).getUserByName;
    builder = byName(app.db, "brick")!;
    reviewer = byName(app.db, "quill")!;
    planner = byName(app.db, "chart")!;
    setCrewRole(app.db, repo.id, reviewer.id, "reviewer");
    setCrewRole(app.db, repo.id, planner.id, "planner");
    for (const title of ["Warp", "Weft", "Shuttle", "Heddle"]) {
      const opened = openIssue(app, alice, repo, { title });
      if (!opened.ok) throw new Error(String(opened.error));
      work.push(opened.value);
    }
    const on = await updateRepoSettings(app, alice, repo, {
      autonomy: "autonomous",
      autonomyDirection: "",
      autonomyCeilingUsd: 10,
      autonomySlots: 2,
      autonomyBy: alice.id,
    });
    expect(on.ok).toBe(true);
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a review and a planner's run take no slot: one builder of two slots, and a builder still starts", async () => {
    running(work[0]!, builder, "assigned");
    running(work[3]!, reviewer, "review");
    running(work[2]!, planner, "assigned");
    const status = autonomyStatus(app, fresh());
    expect(status.slots).toBe(2);
    expect(status.active).toBe(1);
    // Three runs are in flight; one of them spends a slot.
    expect(listRuns(app.db, repo.id, { kind: "agent" }).length).toBe(3);
    expect(await driveRepo(app, fresh())).toBe("picked");
    expect(getIssue(app.db, repo.id, work[1]!.number)!.assigneeId).toBe(
      builder.id,
    );
  });

  test("two builder runs fill both slots: 2 of 2, and the loop says full", async () => {
    running(work[1]!, builder, "assigned");
    const status = autonomyStatus(app, fresh());
    expect(status.active).toBe(2);
    expect(status.active).toBeLessThanOrEqual(status.slots);
    expect(await driveRepo(app, fresh())).toBe("full");
  });
});

describe("the crew in a preview", () => {
  test("crewOffInPreview holds off only for preview, unless turned back on", async () => {
    const { crewOffInPreview } = await import("../src/crew/preview.ts");
    expect(crewOffInPreview({ FORGE_APP_ENV: "preview" })).toBe(true);
    expect(crewOffInPreview({ FORGE_APP_ENV: "production" })).toBe(false);
    expect(crewOffInPreview({})).toBe(false);
    expect(
      crewOffInPreview({ FORGE_APP_ENV: "preview", FORGE_CREW_IN_PREVIEW: "1" }),
    ).toBe(false);
  });

  test("an autonomy tick is a no-op in a preview", async () => {
    const { autonomyTick } = await import("../src/crew/autonomy.ts");
    const dir = await mkdtemp(join(tmpdir(), "forge-prev-"));
    const app = await createApp({ dataDir: dir } as Parameters<typeof createApp>[0]);
    let touched = 0;
    const real = app.db.query.bind(app.db);
    (app.db as { query: unknown }).query = (...a: unknown[]) => {
      touched++;
      return (real as (...x: unknown[]) => unknown)(...a);
    };
    const before = process.env.FORGE_APP_ENV;
    process.env.FORGE_APP_ENV = "preview";
    try {
      await autonomyTick(app);
      expect(touched).toBe(0);
      delete process.env.FORGE_APP_ENV;
      await autonomyTick(app);
      expect(touched).toBeGreaterThan(0);
    } finally {
      if (before === undefined) delete process.env.FORGE_APP_ENV;
      else process.env.FORGE_APP_ENV = before;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
