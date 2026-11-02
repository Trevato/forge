/**
 * A repository that runs on its own: the tick picks what is ready for a
 * builder, honours slots and the ceiling, asks the planner when the map has
 * run dry, and lands green pulls as the person who turned it on. Nothing
 * here starts a real agent; the crew is not running, so an assignment is
 * the observable effect.
 */
import { seatAs } from "./helpers/seat.ts";
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
import {} from "../src/core/agents.ts";
import {
  latestDecision,
  recordDecision,
  resolveOpen,
} from "../src/core/decisions.ts";
import { addDependency } from "../src/core/dependencies.ts";
import { getIssue, getIssueById, type Issue } from "../src/core/issues.ts";
import { getPull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { submitReview } from "../src/core/reviews.ts";
import { claimRun, createRun, finishRun, listRuns } from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { addComment, setIssueState } from "../src/actions/issues.ts";
import {
  autonomyStatus,
  driveRepo,
  holdWhy,
  holdWords,
  plannerHold,
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
    const a = await createUser(app.db, { origin: "seed", trusted: true,
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
      const agent = await createAgent(app, alice, { username: name, roles: ["planner", "builder", "reviewer"] });
      if (!agent.ok) throw new Error(String(agent.error));
      expect(addToCrew(app, alice, repo, name, "builder").ok).toBe(true);
    }
    scout = getUserByName(
      app.db,
      "scout",
    )!;
    mason = getUserByName(
      app.db,
      "mason",
    )!;
    atlas = getUserByName(
      app.db,
      "atlas",
    )!;
    seatAs(app.db, repo.id, atlas.id, "planner");
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
    // Past the interval with nothing new since that pass — nobody spoke,
    // the map has not moved — it is not asked again (#1097)…
    expect(await driveRepo(app, fresh(), later)).toBe("idle");
    // …and once a person speaks on the direction, it is.
    const { addComment } = await import("../src/actions/issues.ts");
    expect(
      addComment(app, alice, fresh(), direction, "Rigid bodies next.").ok,
    ).toBe(true);
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
    const opened = await openPull(app, mason, repo, {
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
    expect(conflicts()[0]!.actorId).toBe(mason.id);
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

  test("a stop on red ends with the green after it: the pull lands on the next tick; a person's stop stays", async () => {
    app.db
      .query("UPDATE repo SET autonomy = 'autonomous' WHERE id = ?1")
      .run(repo.id);
    const proposed = async (name: string) => {
      const branch = await commitToBranch(app, alice, repo, {
        branch: `scout/${name}`,
        base: "main",
        message: name,
        files: [{ path: `${name}.ts`, content: `export const ${name} = 1;\n` }],
      });
      if (!branch.ok) throw new Error(JSON.stringify(branch.error));
      const opened = await openPull(app, scout, repo, {
        title: name,
        baseBranch: "main",
        headBranch: `scout/${name}`,
      });
      if (!opened.ok) throw new Error(String(opened.error));
      return opened.value;
    };
    const check = (
      pull: { id: string; number: number },
      head: string,
      state: "ok" | "failed",
    ) => {
      const run = createRun(app.db, {
        repoId: repo.id,
        kind: "check",
        issueId: pull.id,
        env: `pull-${pull.number}`,
        commitOid: head,
        reason: "retry",
      });
      claimRun(app.db, run.id);
      finishRun(app.db, run.id, { state, summary: state });
      // What dispatch does with every check's result.
      resolveOpen(app.db, pull.id, "retry", state === "ok" ? "green" : "red");
      // An agent's pull ships only once reviewed (#597); this crew has no
      // reviewer, so a person approves each green head. The stop is the subject.
      if (state === "ok")
        submitReview(app.db, { issueId: pull.id, authorId: alice.id, state: "approved", commitOid: head });
    };
    const stop = (pull: { id: string }, state: unknown, by: string) =>
      recordDecision(app.db, {
        kind: "retry",
        repoId: repo.id,
        issueId: pull.id,
        state,
        answer: "stop",
        p: 0.9,
        by,
        ms: 1,
      });
    const crewSaw = { check: { kind: "check", summary: "check failed" } };
    const merged = (n: number) => getPull(app.db, repo.id, n)!.mergedAt !== null;

    // The same head, run again: the red it was run for is history.
    const rerun = await proposed("gravity");
    check(rerun, rerun.headOid, "failed");
    stop(rerun, crewSaw, "decider");
    expect(await sweepGreen(app, fresh())).toBe(0);
    check(rerun, rerun.headOid, "ok");
    expect(latestDecision(app.db, rerun.id, "retry")?.outcome).toBe("green");
    expect(await sweepGreen(app, fresh())).toBe(1);
    expect(merged(rerun.number)).toBe(true);

    // Red on the re-run too, then a newer head that passes.
    const pushed = await proposed("friction");
    check(pushed, pushed.headOid, "failed");
    stop(pushed, crewSaw, "decider");
    check(pushed, pushed.headOid, "failed");
    const again = await commitToBranch(app, alice, repo, {
      branch: "scout/friction",
      message: "friction, fixed",
      files: [{ path: "friction.ts", content: "export const friction = 2;\n" }],
    });
    if (!again.ok) throw new Error(JSON.stringify(again.error));
    const newer = getPull(app.db, repo.id, pushed.number)!;
    expect(newer.headOid).not.toBe(pushed.headOid);
    check(newer, newer.headOid, "ok");
    expect(await sweepGreen(app, fresh())).toBe(1);
    expect(merged(pushed.number)).toBe(true);

    // A stop that is not the crew's answer to a check is a person's: green
    // does not lift it.
    const held = await proposed("drag");
    check(held, held.headOid, "failed");
    stop(held, "hold this one for me", "alice");
    check(held, held.headOid, "ok");
    expect(await sweepGreen(app, fresh())).toBe(0);
    expect(merged(held.number)).toBe(false);
  });

  test("the builder pick is one fixed-choice function", () => {
    const issue = { ...issues[1]!, assigneeId: null };
    const inFlight = new Map([[scout.id, 1]]);
    const scoutAgent = {
      user: scout,
      model: "",
      brief: "",
      budgetUsd: 0,
      roles: ["builder"] as const,
      createdBy: null,
      createdAt: "",
    };
    const masonAgent = {
      user: mason,
      model: "",
      brief: "",
      budgetUsd: 0,
      roles: ["builder"] as const,
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
    // Today's spend against the new ceiling is the forge's crew page's; the
    // map only draws what waits for what.
    const forgeCrew = await (
      await fetch(`${servers.url}/settings/crew`, { headers: { cookie } })
    ).text();
    expect(forgeCrew).toMatch(/alice\/engine[\s\S]*?assisted/);
    expect(forgeCrew).toMatch(/\/ \$25 today/);
    const map = await (
      await fetch(`${servers.url}/alice/engine/map`, { headers: { cookie } })
    ).text();
    expect(map).not.toContain("of $25 today");
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
    const a = await createUser(app.db, { origin: "seed", trusted: true,
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
      const agent = await createAgent(app, alice, { username: name, roles: ["planner", "builder", "reviewer"] });
      if (!agent.ok) throw new Error(String(agent.error));
      expect(addToCrew(app, alice, repo, name, "builder").ok).toBe(true);
    }
    const byName = getUserByName;
    builder = byName(app.db, "brick")!;
    reviewer = byName(app.db, "quill")!;
    planner = byName(app.db, "chart")!;
    seatAs(app.db, repo.id, reviewer.id, "reviewer");
    seatAs(app.db, repo.id, planner.id, "planner");
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

describe("the planner is held while nothing lands or the plate is full", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let repo: Repo;
  let planner: User;
  const fresh = () => getRepoById(app.db, repo.id)!;
  const direction = () => getIssueById(app.db, fresh().directionIssueId!)!;
  let n = 0;
  const closedPull = async (merged: boolean) => {
    n += 1;
    const branch = await commitToBranch(app, alice, repo, {
      branch: `feature/p${n}`,
      base: "main",
      message: `P${n}`,
      files: [{ path: `p${n}.ts`, content: `export const p = ${n};\n` }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: `P${n}`,
      baseBranch: "main",
      headBranch: `feature/p${n}`,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const closed = setIssueState(app, alice, repo, opened.value, "closed");
    if (!closed.ok) throw new Error(String(closed.error));
    if (merged)
      app.db
        .query("UPDATE pull SET merged_at = ?2 WHERE issue_id = ?1")
        .run(opened.value.id, new Date().toISOString());
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-held-"));
    app = createApp({ dataDir, port: 0 });
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createRepo(app, alice, { name: "held", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# held\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    for (const name of ["brick", "chart"]) {
      const agent = await createAgent(app, alice, { username: name, roles: ["planner", "builder", "reviewer"] });
      if (!agent.ok) throw new Error(String(agent.error));
      expect(addToCrew(app, alice, repo, name, "builder").ok).toBe(true);
    }
    const byName = getUserByName;
    planner = byName(app.db, "chart")!;
    seatAs(app.db, repo.id, planner.id, "planner");
    const on = await updateRepoSettings(app, alice, repo, {
      autonomy: "autonomous",
      autonomyDirection: "Weave the loom",
      autonomyCeilingUsd: 10,
      autonomySlots: 1,
      autonomyBy: alice.id,
    });
    expect(on.ok).toBe(true);
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("nothing landed with a pull closed unmerged holds it; a merge releases it; the owner's steer goes through", async () => {
    // Nothing closed yet: a quiet repository is not a stuck one.
    expect(plannerHold(app, fresh())).toBeNull();
    await closedPull(false);
    const hold = plannerHold(app, fresh());
    expect(hold?.kind).toBe("nothing landed");
    expect(holdWhy(hold!)).toMatch(/^nothing landed since \d{4}-\d\d-\d\d$/);
    expect(holdWords(hold!)).toMatch(/^Planning paused: nothing has landed since \w{3} \d+$/);
    await driveRepo(app, fresh());
    expect(direction().assigneeId).toBeNull();
    // The owner steers on the direction issue: never held.
    const said = addComment(app, alice, fresh(), direction(), "Try the shuttle first");
    expect(said.ok).toBe(true);
    expect(plannerHold(app, fresh())).toBeNull();
    // A reader's or an agent's word is not a steer.
    app.db.query("DELETE FROM comment WHERE issue_id = ?1").run(direction().id);
    expect(plannerHold(app, fresh())?.kind).toBe("nothing landed");
    // A pull merges: the hold lifts and the planner is asked.
    await closedPull(true);
    expect(plannerHold(app, fresh())).toBeNull();
    await driveRepo(app, fresh());
    expect(direction().assigneeId).toBe(planner.id);
  });

  test("a merge older than 48 h does not release it, and a closed pull older than that does not hold", async () => {
    const day3 = new Date(Date.now() + 72 * 60 * 60_000);
    expect(plannerHold(app, fresh(), day3)).toBeNull();
    await closedPull(false);
    // Three days on, the old merge is stale; the unmerged pull is too.
    expect(plannerHold(app, fresh(), day3)).toBeNull();
    // Two days after the last merge, with a fresh refusal: held.
    const day2 = new Date(Date.now() + 49 * 60 * 60_000);
    app.db.query("UPDATE issue SET closed_at = ?1 WHERE kind = 'pull'").run(new Date(day2.getTime() - 60_000).toISOString());
    expect(plannerHold(app, fresh(), day2)?.kind).toBe("nothing landed");
  });

  test("more than slots × 3 ready unassigned issues is a full plate, and it drains", () => {
    app.db.query("DELETE FROM issue WHERE kind = 'pull'").run();
    const made: Issue[] = [];
    for (let i = 0; i < 4; i++) {
      const o = openIssue(app, alice, fresh(), { title: `Thread ${i}` });
      if (!o.ok) throw new Error(String(o.error));
      made.push(o.value);
    }
    const hold = plannerHold(app, fresh());
    expect(hold).toEqual({ kind: "plate full", ready: 4 });
    expect(holdWhy(hold!)).toBe("plate full (4 ready)");
    expect(setIssueState(app, alice, fresh(), made[0]!, "closed").ok).toBe(true);
    expect(plannerHold(app, fresh())).toBeNull();
  });
});
