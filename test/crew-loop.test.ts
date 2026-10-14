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
import { commitToBranch } from "../src/actions/repos.ts";
import { openPull, submitReview } from "../src/actions/pulls.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import { handedToPerson, sendToReview, waitsForPerson } from "../src/crew/review.ts";
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
    const a = await createUser(app.db, { trusted: true,
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
    expect(breakerTripped(app.db, fresh(), issue.id)).toBe(true);
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
    expect(breakerTripped(app.db, fresh(), issue.id)).toBe(false);
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
    expect(breakerTripped(app.db, fresh(), issued.value.id)).toBe(false);
  });
});

describe("a crew reviewer's changes-requested wakes the builder", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let mason: User;
  let sentinel: User;
  let repo: Repo;
  let crew: CrewHandle;
  const fresh = () => getRepoById(app.db, repo.id)!;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-verdict-"));
    app = createApp({ dataDir, port: 0 });
    const a = await createUser(app.db, {
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
    await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# engine\n" }],
    });
    for (const name of ["mason", "sentinel"]) {
      const agent = await createAgent(app, alice, { username: name });
      if (!agent.ok) throw new Error(String(agent.error));
      expect(addToCrew(app, alice, repo, name).ok).toBe(true);
    }
    mason = getUserByName(app.db, "mason")!;
    sentinel = getUserByName(app.db, "sentinel")!;
    setCrewRole(app.db, repo.id, sentinel.id, "reviewer");
    crew = await startCrew(app, {
      forgeUrl: "http://127.0.0.1:1",
      localUrl: "http://127.0.0.1:1",
      binary: "/nonexistent/claude",
      concurrency: 0,
      budgetUsd: 1,
      runTimeoutMs: 60_000,
    });
  });

  afterAll(async () => {
    await crew.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function masonPull(name: string) {
    await commitToBranch(app, alice, repo, {
      branch: `feature/${name}`,
      base: "main",
      message: name,
      files: [{ path: `${name}.txt`, content: `${name}\n` }],
    });
    const opened = await openPull(app, alice, repo, {
      title: name,
      baseBranch: "main",
      headBranch: `feature/${name}`,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    app.db
      .query("UPDATE issue SET author_id = ?2 WHERE id = ?1")
      .run(opened.value.id, mason.id);
    return opened.value;
  }
  const feedback = (pull: Pull) =>
    listRuns(app.db, repo.id, { issueId: pull.id }).filter(
      (r) => r.kind === "agent" && r.reason === "feedback",
    );
  /** The reviewer's own runs on the pull, one running as its verdict lands. */
  const reviewing = (pull: Pull, retry = true) => {
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: pull.id,
      actorId: sentinel.id,
      reason: "review",
    });
    claimRun(app.db, run.id);
    // And a retry of the review waiting behind it: also not the builder's.
    if (retry)
      createRun(app.db, {
        repoId: repo.id,
        kind: "agent",
        issueId: pull.id,
        actorId: sentinel.id,
        reason: "review",
      });
    return run;
  };
  const settle = () => new Promise((r) => setTimeout(r, 80));

  for (const autonomy of ["autonomous", "assisted"] as const) {
    test(`in ${autonomy}, the verdict queues the builder's follow-up with no person speaking`, async () => {
      const set = await updateRepoSettings(app, alice, fresh(), {
        autonomy,
        autonomyCeilingUsd: 100,
        autonomyBy: alice.id,
      });
      if (!set.ok) throw new Error(JSON.stringify(set.error));
      const pull = await masonPull(`verdict-${autonomy}`);
      reviewing(pull);
      const sent = await submitReview(app, sentinel, fresh(), pull, {
        state: "changes_requested",
        body: "The token is logged in clear.",
      });
      expect(sent.ok).toBe(true);
      await settle();
      expect(feedback(pull).map((r) => r.actorId)).toEqual([mason.id]);
    });
  }

  test("the third round hands the pull to a person in one card, and starts nothing", async () => {
    const set = await updateRepoSettings(app, alice, fresh(), {
      autonomy: "autonomous",
      autonomyCeilingUsd: 100,
      autonomyBy: alice.id,
    });
    if (!set.ok) throw new Error(JSON.stringify(set.error));
    let pull = await masonPull("verdict-rounds");
    const ask = async (body: string) => {
      const sent = await submitReview(app, sentinel, fresh(), pull, {
        state: "changes_requested",
        body,
      });
      if (!sent.ok) throw new Error(String(sent.error));
      await settle();
    };
    const push = async (n: number) => {
      await commitToBranch(app, alice, repo, {
        branch: "feature/verdict-rounds",
        base: "main",
        message: `more ${n}`,
        files: [{ path: `more-${n}.txt`, content: `${n}\n` }],
      });
      pull = getPull(app.db, repo.id, pull.number)!;
    };
    const cards = () =>
      listComments(app.db, pull.id, { kind: "comment" }).filter((c) =>
        c.body.startsWith("Handed to a person"),
      );
    await ask("First: name the fence.");
    await push(1);
    await ask("Second: the test is missing.");
    await push(2);
    expect(feedback(pull).length).toBe(1);
    expect(handedToPerson(app.db, repo.id, pull)).toBe(false);
    await ask("Third: still no fence.");
    expect(feedback(pull).length).toBe(1);
    expect(handedToPerson(app.db, repo.id, pull)).toBe(true);
    expect(cards().length).toBe(1);
    for (const said of ["First: name", "Second: the test", "Third: still"])
      expect(cards()[0]!.body).toContain(said);
    // Not closed, and it waits where a person looks; a re-sent verdict adds no card.
    expect(getPull(app.db, repo.id, pull.number)!.state).toBe("open");
    expect(waitsForPerson(app.db, repo.id, pull)?.why).toBe("rounds");
    expect(await sendToReview(app, fresh(), pull)).toBe("held");
    await ask("Third again.");
    expect(cards().length).toBe(1);
    // A person's approval ends the handover.
    const ok = await submitReview(app, alice, fresh(), pull, { state: "approved" });
    if (!ok.ok) throw new Error(String(ok.error));
    expect(handedToPerson(app.db, repo.id, pull)).toBe(false);
  });

  test("in off, the verdict queues nothing", async () => {
    const set = await updateRepoSettings(app, alice, fresh(), {
      autonomy: "off",
    });
    if (!set.ok) throw new Error(JSON.stringify(set.error));
    const pull = await masonPull("verdict-off");
    reviewing(pull, false);
    await submitReview(app, sentinel, fresh(), pull, {
      state: "changes_requested",
      body: "Rename it.",
    });
    await settle();
    expect(feedback(pull).length).toBe(0);
  });
});
