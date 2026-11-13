/**
 * The planner is paced, not capped (#2143): the direction issue is its
 * standing issue, so the builders' per-issue run cap never parks it. What
 * bounds planning is the breaker, the replan floor, the hold, the dollar
 * ceiling — and the direction's own, generous day's share.
 */
import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { assignIssue, openIssue, setIssueState } from "../src/actions/issues.ts";
import { createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import {} from "../src/core/agents.ts";
import { getIssueById, type Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { driveRepo } from "../src/crew/autonomy.ts";
import { ISSUE_RUN_CAP, runCapOf } from "../src/crew/guard.ts";

describe("the direction is paced, not capped", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let atlas: User;
  let repo: Repo;
  let direction: Issue;
  const fresh = () => getRepoById(app.db, repo.id)!;

  /** A finished planning pass, `ago` ms before now. */
  function pass(ago: number, state: "ok" | "failed" = "ok"): void {
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: direction.id,
      actorId: atlas.id,
      reason: "assigned",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, {
      state,
      summary: state === "ok" ? "opened #9" : "the provider said no",
      costUsd: 0.1,
    });
    const at = new Date(Date.now() - ago).toISOString();
    app.db
      .query(
        "UPDATE run SET created_at = ?2, started_at = ?2, finished_at = ?2 WHERE id = ?1",
      )
      .run(run.id, at);
  }

  /** Clear the direction and the run history, so each case starts alike. */
  function reset(): void {
    app.db.query("DELETE FROM run WHERE issue_id = ?1").run(direction.id);
    const current = getIssueById(app.db, direction.id)!;
    if (current.assigneeId !== null)
      assignIssue(app, alice, fresh(), current, null);
  }

  /** The map moves after the last pass, so the replan guard has news. */
  async function moveTheMap(): Promise<void> {
    const opened = await openIssue(app, alice, fresh(), { title: "Gone soon" });
    if (!opened.ok) throw new Error(String(opened.error));
    setIssueState(app, alice, fresh(), opened.value, "closed");
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-direction-cap-"));
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
    const made = await createRepo(app, alice, {
      name: "engine",
      visibility: "private",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    for (const name of ["atlas", "mason"]) {
      const agent = await createAgent(app, alice, { username: name });
      if (!agent.ok) throw new Error(String(agent.error));
      expect(addToCrew(app, alice, repo, name).ok).toBe(true);
    }
    atlas = getUserByName(app.db, "atlas")!;
    seatAs(app.db, repo.id, atlas.id, "planner");
    const set = await updateRepoSettings(app, alice, repo, {
      autonomy: "autonomous",
      autonomyDirection: "Keep the engine small.",
      autonomyCeilingUsd: 100,
      autonomyBy: alice.id,
    });
    if (!set.ok) throw new Error(JSON.stringify(set.error));
    expect(await driveRepo(app, fresh())).toBe("planned");
    direction = getIssueById(app.db, fresh().directionIssueId!)!;
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the direction has no cap; the budget bounds the planner", () => {
    expect(runCapOf(fresh(), direction, {})).toBe(Number.POSITIVE_INFINITY);
    expect(runCapOf(fresh(), direction, { issueRunCap: 2 })).toBe(Number.POSITIVE_INFINITY);
  });

  test("twenty passes with no person's word: the twenty-first still runs when the map is thin", async () => {
    reset();
    for (let n = 20; n >= 1; n--) pass(n * 40 * 60_000);
    expect(20).toBeGreaterThan(ISSUE_RUN_CAP);
    await moveTheMap();
    expect(await driveRepo(app, fresh())).toBe("planned");
    expect(getIssueById(app.db, direction.id)!.assigneeId).toBe(atlas.id);
  });

  test("a tripped breaker still parks the planner", async () => {
    reset();
    pass(50 * 60_000, "failed");
    pass(40 * 60_000, "failed");
    pass(30 * 60_000, "failed");
    await moveTheMap();
    expect(await driveRepo(app, fresh())).toBe("idle");
    expect(getIssueById(app.db, direction.id)!.assigneeId).toBeNull();
  });

  test("the run cap still parks an ordinary issue", () => {
    expect(runCapOf(fresh(), { ...direction, id: "other" }, {})).toBe(ISSUE_RUN_CAP);
  });
});
