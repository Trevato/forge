/**
 * A stalled issue frees itself (#4073): a builder that left an issue
 * without a pull has it parked by the next tick — a note with who and why,
 * the assignee cleared — and another builder picks it; the builder that
 * stalled it leaves it for the hour; a second stall hands it to the planner
 * past the direction's day's planning cap; the tick line counts `unstuck`.
 * The repositories are assisted, where nothing parks a stall when its run
 * ends, so the tick is what frees it.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { getAgentByName, setCrewRole } from "../src/core/agents.ts";
import { getIssueById, listComments, type Issue } from "../src/core/issues.ts";
import { getRepoById, listAutonomousRepos, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun, listRuns } from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { autonomyTick, driveRepo, ensureDirectionIssue } from "../src/crew/autonomy.ts";
import { queueAgentRun } from "../src/crew/dispatch.ts";
import { heldNow, heldWords } from "../src/crew/held.ts";
import { PARK_NOTE, parkedTwice } from "../src/crew/parks.ts";
import { leftWithoutPull, NO_PULL, SHUN_MS, stallReason } from "../src/crew/stalls.ts";
import { serve, type Servers } from "../src/http/server.ts";

/** Planning passes the direction may start in a day, here: small enough to reach. */
const DIRECTION_CAP = 2;

let dataDir: string;
let app: App;
let servers: Servers;
let alice: User;
let made = 0;

async function crewed(builders: readonly string[]): Promise<Repo> {
  const created = await createRepo(app, alice, { name: `stalls${++made}`, visibility: "private" });
  if (!created.ok) throw new Error(String(created.error));
  for (const name of ["atlas", ...builders]) {
    if (getUserByName(app.db, name) === undefined) {
      const agent = await createAgent(app, alice, { username: name });
      if (!agent.ok) throw new Error(String(agent.error));
    }
    expect(addToCrew(app, alice, created.value, name).ok).toBe(true);
  }
  setCrewRole(app.db, created.value.id, getUserByName(app.db, "atlas")!.id, "planner");
  const set = await updateRepoSettings(app, alice, created.value, {
    autonomy: "assisted",
    autonomyDirection: "Keep the engine small.",
    autonomyCeilingUsd: 100,
    autonomySlots: 2,
    autonomyBy: alice.id,
  });
  if (!set.ok) throw new Error(JSON.stringify(set.error));
  return getRepoById(app.db, created.value.id)!;
}

function issue(repo: Repo, title: string): Issue {
  const opened = openIssue(app, alice, getRepoById(app.db, repo.id)!, { title });
  if (!opened.ok) throw new Error(String(opened.error));
  return opened.value;
}

/** `by`'s run on `issue` ends without a pull, the issue left assigned to them. */
function stall(issue: Issue, by: User, summary: string): void {
  // Timestamps tick in milliseconds: a run and the note written just before or
  // after it can share one on a quick machine, and a tie reads as "no word since".
  Bun.sleepSync(2);
  const active = listRuns(app.db, issue.repoId, { kind: "agent" }).filter(
    (r) => r.issueId === issue.id && (r.state === "queued" || r.state === "running"),
  );
  const runs =
    active.length > 0
      ? active
      : [createRun(app.db, { repoId: issue.repoId, kind: "agent", issueId: issue.id, actorId: by.id, reason: "assigned" })];
  for (const run of runs) {
    if (run.state === "queued") claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "failed", summary, costUsd: 0.1 });
  }
  app.db.query("UPDATE issue SET assignee_id = ?2 WHERE id = ?1").run(issue.id, by.id);
}

/** Ends whatever the planner has in flight on the direction, and takes it off the planner. */
function plannerDone(repo: Repo): void {
  const direction = getRepoById(app.db, repo.id)!.directionIssueId;
  if (direction === null) return;
  for (const run of listRuns(app.db, repo.id, { kind: "agent" }))
    if (run.issueId === direction && (run.state === "queued" || run.state === "running")) {
      if (run.state === "queued") claimRun(app.db, run.id);
      finishRun(app.db, run.id, { state: "ok", summary: "opened nothing", costUsd: 0.1 });
    }
  app.db.query("UPDATE issue SET assignee_id = NULL WHERE id = ?1").run(direction);
}

/** Lets the run an assignment queues, and any other deferred work, land before the test reads or stalls it. */
async function settle(): Promise<void> {
  for (let n = 0; n < 5; n++) await new Promise((r) => setTimeout(r, 5));
}

/** One tick, with the green sweep left out, and the tick line it said for `repo`. */
async function tick(repo: Repo, now = new Date()): Promise<string> {
  // The tick walks every autonomous repository; only the one under test may
  // take the machine's time, or its verdict would follow the others' load.
  for (const other of listAutonomousRepos(app.db))
    if (other.id !== repo.id) app.db.query("UPDATE repo SET autonomy = 'off' WHERE id = ?1").run(other.id);
  Bun.sleepSync(2);
  const lines: string[] = [];
  const spy = spyOn(console, "info").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  try {
    await autonomyTick(app, now, async () => 0);
  } finally {
    spy.mockRestore();
  }
  await settle();
  return (
    lines.find(
      (l) => l.includes("[autonomy] tick") && l.includes(`repo=alice/${repo.name} `) && l.includes("did="),
    ) ?? ""
  );
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-stalls-"));
  app = createApp({ dataDir, port: 0, directionRunCap: DIRECTION_CAP });
  servers = await serve(app);
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
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("a stall", () => {
  test("is a finished run with no pull, not one cut short or one that proposed", () => {
    expect(leftWithoutPull({ state: "failed", summary: "declined: too big" })).toBe(true);
    expect(leftWithoutPull({ state: "ok", summary: "no changes pushed" })).toBe(true);
    expect(leftWithoutPull({ state: "ok", summary: "opened pull #4" })).toBe(false);
    expect(leftWithoutPull({ state: "running", summary: "" })).toBe(false);
    expect(stallReason("mason", "declined:\n\ntoo  big")).toBe(`@mason's ${NO_PULL}: declined: too big`);
  });
});

describe("a stalled issue frees itself", () => {
  test("the next tick parks it with who and why, and another builder picks it; a second stall goes to the planner past its cap", async () => {
    const repo = await crewed(["mason", "smith"]);
    const mason = getUserByName(app.db, "mason")!;
    const smith = getUserByName(app.db, "smith")!;
    const netcode = issue(repo, "Netcode");
    // The planner's day is spent: its passes on the direction are at the cap.
    const direction = ensureDirectionIssue(app, alice, getRepoById(app.db, repo.id)!)!;
    for (let n = 0; n < DIRECTION_CAP; n++) {
      const run = createRun(app.db, { repoId: repo.id, kind: "agent", issueId: direction.id, actorId: getUserByName(app.db, "atlas")!.id, reason: "assigned" });
      claimRun(app.db, run.id);
      finishRun(app.db, run.id, { state: "ok", summary: "opened #9", costUsd: 0.1 });
      app.db.query("UPDATE run SET created_at = ?2 WHERE id = ?1").run(run.id, new Date(Date.now() - (90 - n) * 60_000).toISOString());
    }

    stall(netcode, mason, "declined: needs a protocol decision");
    expect(heldWords(heldNow(app, getRepoById(app.db, repo.id)!))).toBe("stalled=1");

    const first = await tick(repo);
    expect(first).toContain("unstuck=1");
    expect(first).toContain("did=picked");
    const note = listComments(app.db, netcode.id).at(-1)!;
    expect(note.body.startsWith(PARK_NOTE)).toBe(true);
    expect(note.body).toContain(`@mason's ${NO_PULL}: declined: needs a protocol decision`);
    // Another builder has it: the one that stalled it leaves it for the hour.
    expect(getIssueById(app.db, netcode.id)!.assigneeId).toBe(smith.id);
    // One stall is no reason to plan: the cap holds the planner.
    expect(getIssueById(app.db, direction.id)!.assigneeId).toBeNull();

    // The second builder stalls it too: the next tick hands it to the
    // planner, whose day's cap does not stand in the way.
    plannerDone(repo);
    stall(netcode, smith, "declined: still no protocol");
    const second = await tick(repo);
    expect(second).toContain("unstuck=1");
    expect(getIssueById(app.db, netcode.id)!.assigneeId).toBeNull();
    const handed = parkedTwice(app.db, [getRepoById(app.db, repo.id)!]).find((p) => p.issueId === netcode.id);
    expect(handed?.reasons).toEqual([
      `@mason's ${NO_PULL}: declined: needs a protocol decision`,
      `@smith's ${NO_PULL}: declined: still no protocol`,
    ]);
    const atlas = getUserByName(app.db, "atlas")!;
    expect(getIssueById(app.db, direction.id)!.assigneeId).toBe(atlas.id);
    // The assignment's run starts past the cap, and the direction is not parked for it.
    const pass = queueAgentRun(
      app,
      getRepoById(app.db, repo.id)!,
      getIssueById(app.db, direction.id)!,
      getAgentByName(app.db, "atlas")!,
      "assigned",
      alice.id,
    );
    expect(pass?.actorId).toBe(atlas.id);
    expect(listComments(app.db, direction.id).some((c) => c.body.startsWith(PARK_NOTE))).toBe(false);
    plannerDone(repo);

    // Freed once: the tick after has nothing more to unstick.
    expect(await tick(repo)).toContain("unstuck=0");
  });

  test("the builder that stalled it does not pick it again within the hour", async () => {
    const repo = await crewed(["mason"]);
    const mason = getUserByName(app.db, "mason")!;
    const netcode = issue(repo, "Netcode");
    stall(netcode, mason, "declined: needs a protocol decision");

    const line = await tick(repo);
    expect(line).toContain("unstuck=1");
    expect(line).not.toContain("did=picked");
    expect(getIssueById(app.db, netcode.id)!.assigneeId).toBeNull();
    // Ready and held by nothing: only its builder waits out the hour.
    expect(heldNow(app, getRepoById(app.db, repo.id)!).startable.map((r) => r.issue.id)).toContain(netcode.id);
    plannerDone(repo);

    await settle();
    // Whatever run the tick queued for the shunned builder is not in flight.
    for (const run of listRuns(app.db, repo.id, { kind: "agent" }))
      if (run.state === "queued" || run.state === "running") {
        if (run.state === "queued") claimRun(app.db, run.id);
        finishRun(app.db, run.id, { state: "ok", summary: "opened nothing", costUsd: 0 });
      }
    const later = new Date(Date.now() + SHUN_MS + 60_000);
    expect(await driveRepo(app, getRepoById(app.db, repo.id)!, later)).toBe("picked");
    expect(getIssueById(app.db, netcode.id)!.assigneeId).toBe(mason.id);
  });
});
