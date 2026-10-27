/**
 * Approved, conflicted pulls do not drain one at a time (#6140): a rebase's
 * check goes before a new build's in the lane, the room for more rebases
 * counts only the checks that stand in front of them, a busy builder's
 * pulls go to idle builders round-robin, and the lane reads as
 * `conflicted N, rebasing M, room R` on the tick line and /flow.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { rebasedPulls, rebasesFirst } from "../src/checks/finishing_first.ts";
import { startChecks } from "../src/checks/service.ts";
import type { Agent } from "../src/core/agents.ts";
import { setCapacity } from "../src/core/capacity.ts";
import type { Issue } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { cancelRun, createRun, getRun, listActive } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { readConflictLane } from "../src/crew/conflict_room.ts";
import { finishFields, ownBuilder } from "../src/crew/finishing.ts";
import { serve } from "../src/http/server.ts";
import {
  conflictedPulls,
  noteWaitingToFinish,
  rebaseLane,
  rebaseLaneSays,
} from "../src/flow/conflicted.ts";

let dataDir: string;
let app: App;
let alice: User;
let repo: Repo;

async function issue(title: string): Promise<Issue> {
  const opened = openIssue(app, alice, repo, { title });
  if (!opened.ok) throw new Error(String(opened.error));
  return opened.value;
}

function agentRun(on: Issue, reason: string) {
  return createRun(app.db, { repoId: repo.id, kind: "agent", issueId: on.id, reason });
}

function checkRun(on: Issue) {
  return createRun(app.db, { repoId: repo.id, kind: "check", issueId: on.id, reason: "push" });
}

/** Settle every queued or running run, so each test starts from an empty lane. */
function settleAll() {
  for (const kind of ["agent", "check"] as const)
    for (const run of listActive(app.db, kind)) cancelRun(app.db, run.id, "test");
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-rebase-lane-"));
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
  const made = await createRepo(app, alice, { name: "engine", visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
});

afterAll(async () => {
  app.db.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("a rebase's check goes first in the lane", () => {
  test("a pull whose last builder's run was a conflict run is a rebase; a review after it does not change that", async () => {
    const rebased = await issue("rebased");
    const reviewed = await issue("rebased, then reviewed");
    const built = await issue("a new build");
    const rebuilt = await issue("rebased, then sent back to its builder");
    agentRun(rebased, "conflict");
    agentRun(reviewed, "conflict");
    agentRun(reviewed, "review");
    agentRun(built, "assigned");
    agentRun(rebuilt, "conflict");
    agentRun(rebuilt, "feedback");
    expect(rebasedPulls(app.db, [rebased.id, reviewed.id, built.id, rebuilt.id])).toEqual(
      new Set([rebased.id, reviewed.id]),
    );
    expect(rebasedPulls(app.db, [])).toEqual(new Set());
    settleAll();
  });

  test("rebasesFirst splits queued checks, keeping each side's order", async () => {
    const rebased = await issue("rebased pull");
    const built = await issue("built pull");
    agentRun(rebased, "conflict");
    agentRun(built, "assigned");
    const newBuild = checkRun(built);
    const rebase = checkRun(rebased);
    const main = createRun(app.db, { repoId: repo.id, kind: "check", env: "main" });
    const split = rebasesFirst(app.db, [newBuild, rebase, main]);
    expect(split.rebases.map((r) => r.id)).toEqual([rebase.id]);
    expect(split.rest.map((r) => r.id)).toEqual([newBuild.id, main.id]);
    settleAll();
  });
});

describe("the room counts only the checks in front of a rebase", () => {
  test("new builds' checks take no room; rebases' checks and conflict runs do", async () => {
    setCapacity(app.db, "checks.concurrency", "4", alice.id);
    for (let i = 0; i < 6; i++) {
      const built = await issue(`build ${i}`);
      agentRun(built, "assigned");
      checkRun(built);
    }
    // Six new builds' checks in a lane of four: before #6140 the room was one.
    expect(readConflictLane(app.db)).toEqual({ runs: 0, checks: 0, room: 4 });
    const rebased = await issue("rebased, check queued");
    // Its conflict run ended with a push; the push's check waits.
    cancelRun(app.db, agentRun(rebased, "conflict").id, "pushed");
    checkRun(rebased);
    const rebasing = await issue("being rebased");
    agentRun(rebasing, "conflict");
    expect(readConflictLane(app.db)).toEqual({ runs: 1, checks: 1, room: 2 });
    settleAll();
  });
});

describe("a pull's rebase goes to the builder who can push it (#7006)", () => {
  const builder = (id: string): Agent => ({ user: { id, username: id } }) as unknown as Agent;
  const [ada, bo, cy, di] = ["ada", "bo", "cy", "di"].map(builder) as [Agent, Agent, Agent, Agent];
  const crew = [di, bo, ada, cy];

  test("the fork's owner, else the author, else the agent on it", () => {
    const on = { assigneeId: "cy", authorId: "bo" } as Issue;
    expect(ownBuilder(on, crew, new Map(), "ada")?.user.id).toBe("ada");
    expect(ownBuilder(on, crew, new Map(), "alice")?.user.id).toBe("bo");
    expect(ownBuilder({ ...on, authorId: "alice" } as Issue, crew, new Map())?.user.id).toBe("cy");
  });

  test("a busy author keeps the rebase: it is never lent to an idle builder", () => {
    const load = new Map([["bo", 1]]);
    expect(ownBuilder({ assigneeId: null, authorId: "bo" } as Issue, crew, load, "bo")?.user.id).toBe("bo");
  });
});

describe("the lane reads as conflicted N, rebasing M, room R", () => {
  test("words, and nothing said when nothing is conflicted or rebasing", () => {
    expect(rebaseLaneSays({ conflicted: 64, rebasing: 1, room: 1 })).toBe("conflicted 64, rebasing 1, room 1");
    expect(rebaseLaneSays({ conflicted: 0, rebasing: 0, room: 7 })).toBeNull();
  });

  test("the tick line carries the lane beside the finishing counts", () => {
    const fields = finishFields(
      [
        { pull: 1, did: "queued update", builder: "bo" },
        { pull: 2, did: "not moved", why: "waits for room in the check lane" },
      ],
      { runs: 1, checks: 2, room: 0 },
    );
    expect(fields).toEqual({
      finishing: "queued 1, in flight 0, skipped 1: waits for room in the check lane×1",
      lane: "conflicted 2, rebasing 3, room 0",
    });
    expect(finishFields([])).toEqual({});
  });

  test("approved pulls waiting for room count as conflicted, oldest first, and a private one only for the owner", () => {
    // Other suites' ticks note their own repositories in the same process: read only this one.
    const mine = (publicOnly = false) =>
      conflictedPulls(app.db, publicOnly).filter((p) => p.repo === "zed/noted");
    noteWaitingToFinish(app.db, "zed-noted", [
      { repo: "zed/noted", number: 9, since: "2026-10-26T10:00:00.000Z", public: false },
      { repo: "zed/noted", number: 4, since: "2026-10-26T09:00:00.000Z", public: true },
    ]);
    // Seen again later: each keeps when it was first seen.
    noteWaitingToFinish(app.db, "zed-noted", [
      { repo: "zed/noted", number: 9, since: "2026-10-26T11:00:00.000Z", public: false },
      { repo: "zed/noted", number: 4, since: "2026-10-26T11:00:00.000Z", public: true },
    ]);
    expect(mine().map((p) => [p.number, p.since])).toEqual([
      [4, "2026-10-26T09:00:00.000Z"],
      [9, "2026-10-26T10:00:00.000Z"],
    ]);
    expect(mine(true).map((p) => p.number)).toEqual([4]);
    expect(rebaseLane(app.db, mine()).conflicted).toBe(2);
    noteWaitingToFinish(app.db, "zed-noted", []);
    expect(mine()).toEqual([]);
  });

  test("a pull noted on one database is not read from another", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-noted-b-"));
    const other = createApp({ dataDir: dir, port: 0 }).db;
    const pull = { repo: "zed/solo", number: 3, since: "2026-10-26T10:00:00.000Z", public: true };
    noteWaitingToFinish(app.db, "zed-solo", [pull]);
    expect(conflictedPulls(other)).toEqual([]);
    expect(conflictedPulls(app.db).filter((p) => p.repo === "zed/solo")).toHaveLength(1);
    noteWaitingToFinish(app.db, "zed-solo", []);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("the checks service starts a rebase's check before a newer build's", () => {
  test("with one slot, the older rebase's check runs first though the newest would otherwise win", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-rebase-first-"));
    const own = createApp({ dataDir: dir, port: 0 });
    const servers = await serve(own);
    const go = join(dir, "go");
    let checks: ReturnType<typeof startChecks> | undefined;
    try {
      const made = await createUser(own.db, {
        origin: "seed",
        trusted: true,
        username: "alice",
        email: "alice@forge.local",
        password: "a-good-passphrase",
        adminIfFirst: true,
      });
      if (!made.ok) throw new Error(made.error);
      const created = await createRepo(own, made.value, { name: "lane", visibility: "public" });
      if (!created.ok) throw new Error(String(created.error));
      const lane = created.value;
      const pushed = await commitToBranch(own, made.value, lane, {
        message: "Check me",
        files: [{ path: "forge.json", content: JSON.stringify({ check: { run: `while [ ! -f ${go} ]; do sleep 0.05; done` } }) }],
      });
      if (!pushed.ok) throw new Error(JSON.stringify(pushed.error));
      const ask = (title: string) => {
        const opened = openIssue(own, made.value, lane, { title });
        if (!opened.ok) throw new Error(String(opened.error));
        return opened.value;
      };
      const rebased = ask("rebased");
      const built = ask("built");
      createRun(own.db, { repoId: lane.id, kind: "agent", issueId: rebased.id, reason: "conflict" });
      createRun(own.db, { repoId: lane.id, kind: "agent", issueId: built.id, reason: "assigned" });
      for (const run of listActive(own.db, "agent")) cancelRun(own.db, run.id, "pushed");
      const check = (on: Issue) =>
        createRun(own.db, { repoId: lane.id, kind: "check", env: "production", issueId: on.id, commitOid: pushed.value.commitOid, reason: "push" });
      const rebase = check(rebased);
      const build = check(built);
      setCapacity(own.db, "checks.concurrency", "1", made.value.id);
      checks = startChecks(own, { forgeUrl: servers.url, concurrency: 1 });
      const state = (id: string) => getRun(own.db, id)?.state;
      const deadline = Date.now() + 60_000;
      while (state(rebase.id) === "queued" && state(build.id) === "queued" && Date.now() < deadline) await Bun.sleep(50);
      expect(state(rebase.id)).toBe("running");
      expect(state(build.id)).toBe("queued");
    } finally {
      writeFileSync(go, "");
      await checks?.stop();
      servers.stop();
      own.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
