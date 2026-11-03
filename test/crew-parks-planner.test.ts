/**
 * The planner's side of a park, end to end: a stand-in Claude Code is handed
 * the issue parked twice and why, and a pull whose review loop is spent; and
 * migration 43 rewords old outage parks so they no longer count. Split from
 * `test/crew-parks.test.ts`, whose `engine` it shares.
 */
import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import {} from "../src/core/agents.ts";
import { listRuns } from "../src/core/runs.ts";
import { migrations } from "../src/core/schema.ts";
import { submitReview } from "../src/core/reviews.ts";
import { getUserByName } from "../src/core/users.ts";
import { handedOverPulls } from "../src/crew/guard.ts";
import { driveRepo } from "../src/crew/autonomy.ts";
import { startCrew, type CrewHandle } from "../src/crew/dispatch.ts";
import { engine, tick, type Engine } from "./helpers/parks-engine.ts";

describe("the planner's run, with a stand-in Claude Code", () => {
  let e: Engine;
  let crew: CrewHandle;
  let promptFile: string;

  beforeAll(async () => {
    e = await engine("forge-parked-brief-");
    const seeded = await commitToBranch(e.app, e.alice, e.repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# engine\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    promptFile = join(e.dataDir, "fake.prompt");
    // The stand-in: records what it was told, plans nothing, pushes nothing.
    const fake = join(e.dataDir, "fake-claude");
    writeFileSync(
      fake,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
IFS= read -r first; printf '%s\\n' "$first" > "${promptFile}"
echo '{"type":"system","subtype":"init","session_id":"fake-plan","model":"fake"}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"Nothing to add.","total_cost_usd":0.01,"num_turns":1,"session_id":"fake-plan","terminal_reason":"completed"}'
`,
    );
    chmodSync(fake, 0o755);
    crew = await startCrew(e.app, {
      forgeUrl: e.servers.url,
      localUrl: e.servers.url,
      binary: fake,
      concurrency: 1,
      budgetUsd: 1,
      runTimeoutMs: 60_000,
      tickMs: 50,
    });
  }, 30_000);

  afterAll(async () => {
    await crew.stop();
    await e.close();
  });

  test("second park, next tick, and the planning run's task carries the issue and why", async () => {
    const work = e.issue("Scene graph");
    e.ended(work, "no changes pushed: DECLINED: out of scope");
    await tick();
    e.ended(work, "nothing to propose");
    await tick();
    // The crew's own tick may ask the planner first; either way it is asked once.
    await driveRepo(e.app, e.fresh());
    const deadline = Date.now() + 45_000;
    while (e.fresh().directionIssueId == null && Date.now() < deadline) await Bun.sleep(50);
    if (e.fresh().directionIssueId == null) throw new Error(`never came: still waiting while e.fresh().directionIssueId == null`);
    const direction = e.fresh().directionIssueId!;
    const settled = () =>
      listRuns(e.app.db, e.repo.id, { kind: "agent" }).find(
        (r) =>
          r.issueId === direction &&
          (r.state === "ok" || r.state === "failed" || r.state === "cancelled"),
      );
    while (settled() === undefined && Date.now() < deadline)
      await Bun.sleep(100);
    expect(settled()?.actorId).toBe(e.atlas.id);
    expect(existsSync(promptFile)).toBe(true);
    const told = readFileSync(promptFile, "utf8");
    expect(told).toContain(`- Parked twice: #${work.number} Scene graph`);
    expect(told).toContain(
      "1. the run ended without a pull: no changes pushed: DECLINED: out of scope",
    );
    expect(told).toContain(
      "2. the run ended without a pull: nothing to propose",
    );
  }, 60_000);
});

describe("a pull whose review loop is spent is the planner's (#1655)", () => {
  let e: Engine;
  let crew: CrewHandle;
  let promptFile: string;
  let fakeBinary: string;

  beforeAll(async () => {
    e = await engine("forge-spent-pull-");
    const seeded = await commitToBranch(e.app, e.alice, e.repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# engine\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    promptFile = join(e.dataDir, "fake.prompt");
    const fake = join(e.dataDir, "fake-claude");
    writeFileSync(
      fake,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
IFS= read -r first; printf '%s\\n' "$first" > "${promptFile}"
echo '{"type":"system","subtype":"init","session_id":"fake-plan","model":"fake"}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"Nothing to add.","total_cost_usd":0.01,"num_turns":1,"session_id":"fake-plan","terminal_reason":"completed"}'
`,
    );
    chmodSync(fake, 0o755);
    fakeBinary = fake;
  }, 30_000);

  afterAll(async () => {
    await crew?.stop();
    await e.close();
  });

  test("the planner is asked for it and its brief says three reviews asked for changes", async () => {
    const agent = await createAgent(e.app, e.alice, { username: "sentinel" });
    if (!agent.ok) throw new Error(String(agent.error));
    expect(addToCrew(e.app, e.alice, e.fresh(), "sentinel").ok).toBe(true);
    const sentinel = getUserByName(e.app.db, "sentinel")!;
    seatAs(e.app.db, e.repo.id, sentinel.id, "reviewer");
    const branch = await commitToBranch(e.app, e.alice, e.fresh(), {
      branch: "feature/spent",
      base: "main",
      message: "spent",
      files: [{ path: "spent.txt", content: "spent\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(e.app, e.alice, e.fresh(), {
      title: "Spent loop",
      baseBranch: "main",
      headBranch: "feature/spent",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    e.app.db.query("UPDATE issue SET author_id = ?2 WHERE id = ?1").run(pull.id, e.mason.id);
    for (const n of [1, 2, 3])
      submitReview(e.app.db, {
        issueId: pull.id,
        authorId: sentinel.id,
        state: "changes_requested",
        body: `Round ${n}`,
        commitOid: pull.headOid,
      });
    expect(handedOverPulls(e.app.db, e.fresh()).map((h) => h.number)).toEqual([pull.number]);
    // The crew starts only now: ticking earlier could ask the planner before the pull is spent.
    crew = await startCrew(e.app, {
      forgeUrl: e.servers.url,
      localUrl: e.servers.url,
      binary: fakeBinary,
      concurrency: 1,
      budgetUsd: 1,
      runTimeoutMs: 60_000,
      tickMs: 50,
    });
    // The crew's own tick may ask the planner first; either way it is asked once.
    // Its answer depends on pacing and on a run the tick already has in flight, so it is not asserted: the planner's brief is.
    await driveRepo(e.app, e.fresh());
    const deadline = Date.now() + 45_000;
    while (e.fresh().directionIssueId == null && Date.now() < deadline) await Bun.sleep(50);
    if (e.fresh().directionIssueId == null) throw new Error(`never came: still waiting while e.fresh().directionIssueId == null`);
    const direction = e.fresh().directionIssueId!;
    const settled = () =>
      listRuns(e.app.db, e.repo.id, { kind: "agent" }).find(
        (r) => r.issueId === direction && ["ok", "failed", "cancelled"].includes(r.state),
      );
    while (settled() === undefined && Date.now() < deadline) await Bun.sleep(100);
    if (settled() === undefined) throw new Error(`never came: still waiting while settled() === undefined`);
    while (!existsSync(promptFile) && Date.now() < deadline) await Bun.sleep(50);
    expect(existsSync(promptFile)).toBe(true);
    const told = readFileSync(promptFile, "utf8");
    expect(told).toContain(`Three reviews asked for changes, pull #${pull.number} Spent loop`);
    expect(told).toContain("Round 3");
    expect(told).toContain("A pull above is not closed by splitting an issue");
  }, 60_000);
});

describe("migration 43", () => {
  test("rewords old outage parks so they no longer count, and leaves real parks", () => {
    const db = new Database(":memory:");
    db.exec(
      "CREATE TABLE comment (id TEXT PRIMARY KEY, issue_id TEXT, author_id TEXT, body TEXT)",
    );
    const bodies = [
      "Parked by the crew: the run ended without a pull: every subscription this repository may use is resting (You've hit your weekly limit)",
      "Parked by the crew: the run ended without a pull: the run failed: Error: API unreachable",
      "Parked by the crew: the run ended without a pull: cancelled",
      "Parked by the crew: the run ended without a pull: nothing to propose",
      "Parked by the crew: the check stayed red past its tries.",
    ];
    bodies.forEach((body, n) =>
      db
        .query("INSERT INTO comment VALUES (?1, 'i', 'u', ?2)")
        .run(String(n), body),
    );
    db.exec(migrations[42]!);
    const after = db
      .query<{ body: string }, []>("SELECT body FROM comment ORDER BY id")
      .all()
      .map((r) => r.body);
    expect(after[0]).toBe(
      "Interrupted, not parked: the run ended without a pull: every subscription this repository may use is resting (You've hit your weekly limit)",
    );
    expect(after[1]).toStartWith("Interrupted, not parked: ");
    expect(after[2]).toStartWith("Interrupted, not parked: ");
    expect(after[3]).toBe(bodies[3]!);
    expect(after[4]).toBe(bodies[4]!);
  });
});
