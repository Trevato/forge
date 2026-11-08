/**
 * The standing reserve (#3237): the planner is asked whenever fewer issues
 * can start than two per builder slot, not only when the map runs dry; its
 * brief names the target; the tick line says `reserve=startable/target`;
 * and only a pass that did not end well waits out the 20-minute floor.
 */
import { seatAs } from "./helpers/seat.ts";
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { addComment, openIssue, setIssueState } from "../src/actions/issues.ts";
import { commitToBranch, createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { getAgentByName } from "../src/core/agents.ts";
import { getIssueById, type Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { autonomyTick, driveRepo, settleAgentRun } from "../src/crew/autonomy.ts";
import { taskPrompt } from "../src/crew/brief.ts";
import { reserveOf, reserveTarget, reserveWords } from "../src/crew/reserve.ts";
import { logLevel, setLogLevel } from "../src/kernel/log.ts";

describe("the reserve's size", () => {
  test("two per builder slot, never fewer than a thin map's three", () => {
    expect(reserveTarget(7)).toBe(14);
    expect(reserveTarget(2)).toBe(4);
    expect(reserveTarget(1)).toBe(3);
    expect(reserveTarget(0)).toBe(3);
    expect(reserveWords(reserveOf(5, 7))).toBe("5/14");
  });
});

describe("a planner that keeps a standing reserve", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let mason: User;
  let atlas: User;
  let repo: Repo;
  const free: Issue[] = [];
  const fresh = () => getRepoById(app.db, repo.id)!;
  const minutesOn = (n: number) => new Date(Date.now() + n * 60_000);
  const level = logLevel();
  let lines: string[] = [];
  let spy: ReturnType<typeof spyOn> | undefined;
  const listen = () => {
    lines = [];
    spy = spyOn(console, "info").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
  };
  const close = (issue: Issue) =>
    expect(setIssueState(app, alice, fresh(), getIssueById(app.db, issue.id)!, "closed").ok).toBe(true);
  const planningRun = (state: "ok" | "failed", summary: string) => {
    const direction = getIssueById(app.db, fresh().directionIssueId!)!;
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: direction.id,
      actorId: atlas.id,
      reason: "assigned",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state, summary, costUsd: 0.5 });
    settleAgentRun(app, fresh(), {
      issueId: direction.id,
      state,
      summary,
      reason: "assigned",
      actorId: atlas.id,
    });
    expect(getIssueById(app.db, direction.id)!.assigneeId).toBeNull();
    return direction;
  };

  beforeAll(async () => {
    setLogLevel("info");
    dataDir = await mkdtemp(join(tmpdir(), "forge-reserve-"));
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
    const made = await createRepo(app, alice, { name: "engine", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# engine\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    for (const name of ["mason", "atlas"]) {
      const agent = await createAgent(app, alice, { username: name });
      if (!agent.ok) throw new Error(String(agent.error));
      expect(addToCrew(app, alice, repo, name).ok).toBe(true);
    }
    mason = getUserByName(app.db, "mason")!;
    atlas = getUserByName(app.db, "atlas")!;
    seatAs(app.db, repo.id, atlas.id, "planner");
    // Seven slots, every one of them busy: seven issues with a run in flight.
    for (let n = 0; n < 7; n++) {
      const opened = openIssue(app, alice, repo, { title: `Busy ${n}` });
      if (!opened.ok) throw new Error(String(opened.error));
      claimRun(
        app.db,
        createRun(app.db, {
          repoId: repo.id,
          kind: "agent",
          issueId: opened.value.id,
          actorId: mason.id,
          reason: "assigned",
        }).id,
      );
    }
    // A full reserve: fourteen issues a builder could start.
    for (let n = 0; n < 14; n++) {
      const opened = openIssue(app, alice, repo, { title: `Free ${n}` });
      if (!opened.ok) throw new Error(String(opened.error));
      free.push(opened.value);
    }
    const set = await updateRepoSettings(app, alice, repo, {
      autonomy: "autonomous",
      autonomyDirection: "Keep the engine small.",
      autonomyCeilingUsd: 100,
      autonomySlots: 7,
      autonomyBy: alice.id,
    });
    if (!set.ok) throw new Error(JSON.stringify(set.error));
  });

  afterEach(() => {
    spy?.mockRestore();
    spy = undefined;
  });

  afterAll(async () => {
    setLogLevel(level);
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a full reserve with every slot busy is not a reason to plan", async () => {
    expect(await driveRepo(app, fresh())).toBe("full");
    expect(fresh().directionIssueId).toBeNull();
  });

  test("7 slots, 5 startable: the planner is asked, with target 14", async () => {
    for (const issue of free.splice(0, 9)) close(issue);
    listen();
    expect(await driveRepo(app, fresh())).toBe("planned");
    const direction = getIssueById(app.db, fresh().directionIssueId!)!;
    expect(direction.assigneeId).toBe(atlas.id);
    const asked = lines.find((l) => l.includes("reserve is short; planner asked"));
    expect(asked).toContain("ready=5");
    expect(asked).toContain("reserve=5/14");
  });

  test("the planner's brief names the reserve and asks why when it is left short", () => {
    const direction = getIssueById(app.db, fresh().directionIssueId!)!;
    const brief = taskPrompt({
      agent: getAgentByName(app.db, "atlas")!,
      repo: fresh(),
      issue: direction,
      branch: "atlas/1-direction",
      forgeUrl: "http://forge.test",
      isApp: false,
      resuming: false,
      role: "planner",
      reason: "assigned",
      comments: [],
      reviews: [],
      reviewComments: [],
      since: direction.createdAt,
      reserve: reserveOf(5, 7),
    });
    expect(brief).toContain("standing reserve of 14 startable issues");
    expect(brief).toContain("5 can start now: plan at least 9 more");
    expect(brief).toContain(`If you finish with fewer than 14 startable, say why in a comment on #${direction.number}`);
    expect(brief).not.toContain("at least three ready issues");
  });

  test("the tick line says reserve=startable/target", async () => {
    listen();
    await autonomyTick(app);
    const tick = lines.find((l) => l.includes("[autonomy] tick") && l.includes("did="));
    expect(tick).toContain("startable=5");
    expect(tick).toContain("reserve=5/14");
  });

  test("a pass that ended well has no floor: the map moved, so it is asked again at once", async () => {
    planningRun("ok", "opened #30; ready now: 5");
    await Bun.sleep(5);
    close(free.shift()!);
    expect(await driveRepo(app, fresh(), minutesOn(1))).toBe("planned");
  });

  test("a pass that ended well and moved nothing is not asked again", async () => {
    planningRun("ok", "nothing left in the direction; said why on it");
    expect(await driveRepo(app, fresh(), minutesOn(1))).toBe("full");
    expect(await driveRepo(app, fresh(), minutesOn(30))).toBe("full");
  });

  test("a planner that declined waits out the 20-minute floor once a person answers", async () => {
    const direction = planningRun("failed", "declined: nothing in the direction to plan");
    await Bun.sleep(5);
    expect(addComment(app, alice, fresh(), direction, "Plan the renderer next.").ok).toBe(true);
    listen();
    expect(await driveRepo(app, fresh(), minutesOn(1))).toBe("full");
    expect(lines.some((l) => l.includes("planned recently"))).toBe(true);
    expect(await driveRepo(app, fresh(), minutesOn(21))).toBe("planned");
  });
});
