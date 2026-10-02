/**
 * Tonight's loop: the planner declines the direction, and the decline starts
 * the next run, 27 times. An agent's own words start nothing; a declined run
 * leaves no comment; a finished planning run lets go of the direction; three
 * failed runs in an hour park the issue until a person speaks.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { addComment, openIssue } from "../src/actions/issues.ts";
import { createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { setCrewRole } from "../src/core/agents.ts";
import { getIssueById, listComments, type Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun, listRuns } from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { driveRepo, settleAgentRun } from "../src/crew/autonomy.ts";
import { startCrew, queueAgentRun, type CrewHandle } from "../src/crew/dispatch.ts";
import { getAgent } from "../src/core/agents.ts";
import { breakerParked, breakerTripped } from "../src/crew/breaker.ts";

describe("an agent's own comment never starts its next run", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let atlas: User;
  let repo: Repo;
  let direction: Issue;
  const fresh = () => getRepoById(app.db, repo.id)!;
  const agentRuns = (issue: Issue) =>
    listRuns(app.db, repo.id).filter(
      (r) => r.issueId === issue.id && r.kind === "agent",
    );

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-loop-"));
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
    for (const name of ["atlas", "mason"]) {
      const agent = await createAgent(app, alice, { username: name });
      if (!agent.ok) throw new Error(String(agent.error));
      expect(addToCrew(app, alice, repo, name).ok).toBe(true);
    }
    atlas = getUserByName(app.db, "atlas")!;
    setCrewRole(app.db, repo.id, atlas.id, "planner");
    const set = await updateRepoSettings(app, alice, repo, {
      autonomy: "autonomous",
      autonomyDirection: "Keep the engine small.",
      autonomyCeilingUsd: 100,
      autonomyBy: alice.id,
    });
    if (!set.ok) throw new Error(JSON.stringify(set.error));
    expect(await driveRepo(app, fresh())).toBe("planned");
    direction = getIssueById(app.db, fresh().directionIssueId!)!;
    expect(direction.assigneeId).toBe(atlas.id);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a finished planning run lets go of the direction", () => {
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: direction.id,
      actorId: atlas.id,
      reason: "assigned",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, {
      state: "failed",
      summary: "declined: not feedback from a person",
      costUsd: 1.4,
    });
    settleAgentRun(app, fresh(), {
      issueId: direction.id,
      state: "failed",
      summary: "declined: not feedback from a person",
      reason: "assigned",
      actorId: atlas.id,
    });
    expect(getIssueById(app.db, direction.id)!.assigneeId).toBeNull();
  });

  test("a declined planner is not asked again until a person speaks", async () => {
    const later = new Date(Date.now() + 7 * 60 * 60_000);
    expect(await driveRepo(app, fresh(), later)).toBe("idle");
    expect(getIssueById(app.db, direction.id)!.assigneeId).toBeNull();
    addComment(app, alice, fresh(), direction, "Plan the renderer first.");
    expect(await driveRepo(app, fresh(), later)).toBe("planned");
  });

  test("an agent's comment on an assigned issue queues nothing", async () => {
    const crew: CrewHandle = await startCrew(app, {
      forgeUrl: servers.url,
      localUrl: servers.url,
      binary: "/nonexistent/claude",
      concurrency: 0,
      budgetUsd: 1,
      runTimeoutMs: 60_000,
    });
    const issued = openIssue(app, alice, fresh(), { title: "Loop", body: "" });
    if (!issued.ok) throw new Error(String(issued.error));
    const issue = issued.value;
    const { assignIssue } = await import("../src/actions/issues.ts");
    assignIssue(app, alice, fresh(), issue, atlas);
    await new Promise((r) => setTimeout(r, 50));
    // The person's assignment started one run; the agent's words add none.
    expect(agentRuns(issue).length).toBe(1);
    const before = agentRuns(issue).length;
    for (let i = 0; i < 5; i++) {
      addComment(app, atlas, fresh(), issue, `Declined: not feedback ${i}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(agentRuns(issue).length).toBe(before);
    await crew.stop();
  });

  test("three failed runs in an hour park the issue; a person's word frees it", () => {
    const issued = openIssue(app, alice, fresh(), { title: "Stuck", body: "" });
    if (!issued.ok) throw new Error(String(issued.error));
    const issue = issued.value;
    const agent = getAgent(app.db, atlas.id)!;
    for (let i = 0; i < 3; i++) {
      const r = createRun(app.db, {
        repoId: repo.id,
        kind: "agent",
        issueId: issue.id,
        actorId: atlas.id,
        reason: "feedback",
      });
      claimRun(app.db, r.id);
      finishRun(app.db, r.id, { state: "failed", summary: "declined: no", costUsd: 1 });
    }
    expect(breakerTripped(app.db, issue.id)).toBe(true);
    const before = agentRuns(issue).length;
    expect(
      queueAgentRun(app, fresh(), issue, agent, "feedback", alice.id),
    ).toBeUndefined();
    expect(agentRuns(issue).length).toBe(before);
    const parked = listComments(app.db, issue.id).at(-1)!;
    expect(parked.body).toStartWith("Parked by the crew");
    expect(breakerParked(app.db, [repo.id]).map((p) => p.issueId)).toContain(
      issue.id,
    );
    // Asked again, it says nothing more.
    queueAgentRun(app, fresh(), issue, agent, "feedback", alice.id);
    expect(listComments(app.db, issue.id).length).toBe(1);
    // A person speaks: the breaker lets go.
    addComment(app, alice, fresh(), issue, "Try the other way.");
    expect(breakerTripped(app.db, issue.id)).toBe(false);
    expect(breakerParked(app.db, [repo.id])).toEqual([]);
  });

  test("two failures, or three spread over hours, trip nothing", () => {
    const issued = openIssue(app, alice, fresh(), { title: "Fine", body: "" });
    if (!issued.ok) throw new Error(String(issued.error));
    for (let i = 0; i < 2; i++) {
      const r = createRun(app.db, {
        repoId: repo.id,
        kind: "agent",
        issueId: issued.value.id,
        actorId: atlas.id,
        reason: "feedback",
      });
      claimRun(app.db, r.id);
      finishRun(app.db, r.id, { state: "failed", summary: "x", costUsd: 0 });
    }
    expect(breakerTripped(app.db, issued.value.id)).toBe(false);
  });
});
