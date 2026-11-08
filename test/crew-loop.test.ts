/**
 * Tonight's loop: the planner declines the direction, and the decline starts
 * the next run, 27 times. An agent's own words start nothing; a declined run
 * leaves no comment; a finished planning run lets go of the direction; three
 * failed runs in an hour park the issue until a person speaks.
 */
import { seatAs } from "./helpers/seat.ts";
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
import { HANDOVER_NOTE, handedOverPulls, handoverOf } from "../src/crew/guard.ts";
import { addReviewComment } from "../src/core/reviews.ts";
import { sendToReview, waitsForPerson } from "../src/crew/review.ts";
import { createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import {} from "../src/core/agents.ts";
import { getIssueById, listComments, type Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun, listRuns } from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { driveRepo, settleAgentRun } from "../src/crew/autonomy.ts";
import { startCrew, queueAgentRun, type CrewHandle } from "../src/crew/dispatch.ts";
import { getAgent } from "../src/core/agents.ts";
import type { Ctx } from "../src/http/context.ts";
import { setIssueState } from "../src/actions/issues.ts";
import { ASK_WORDS, KIND_TIER, askLinesFor, endOf } from "../src/web/studio/asks.ts";
import { decisionActions, decisionForm, decisionsFor } from "../src/web/studio/decisions.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
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
    // A builder: an issue assigned to the planner is explained, not run (#8907).
    const builder = getUserByName(app.db, "mason")!;
    assignIssue(app, alice, fresh(), issue, builder);
    await new Promise((r) => setTimeout(r, 50));
    // The person's assignment started one run; the agent's words add none.
    expect(agentRuns(issue).length).toBe(1);
    const before = agentRuns(issue).length;
    for (let i = 0; i < 5; i++) {
      addComment(app, builder, fresh(), issue, `Declined: not feedback ${i}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(agentRuns(issue).length).toBe(before);
    await crew.stop();
  });

  test("three failed runs in an hour park the issue; a person's word frees it", () => {
    const issued = openIssue(app, alice, fresh(), { title: "Stuck", body: "" });
    if (!issued.ok) throw new Error(String(issued.error));
    const issue = issued.value;
    const agent = getAgent(app.db, getUserByName(app.db, "mason")!.id)!;
    for (let i = 0; i < 3; i++) {
      const r = createRun(app.db, {
        repoId: repo.id,
        kind: "agent",
        issueId: issue.id,
        actorId: getUserByName(app.db, "mason")!.id,
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
    seatAs(app.db, repo.id, sentinel.id, "reviewer");
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
    expect(handoverOf(app.db, fresh(), pull.id)).toBeUndefined();
    await ask("Third: still no fence.");
    expect(feedback(pull).length).toBe(1);
    expect(handoverOf(app.db, fresh(), pull.id)).toBeDefined();
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
    expect(handoverOf(app.db, fresh(), pull.id)).toBeUndefined();
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

  /** The builder's queued follow-ups end, so each round is counted on its own. */
  const settleFeedback = (pull: Pull) => {
    for (const r of feedback(pull)) {
      claimRun(app.db, r.id);
      finishRun(app.db, r.id, { state: "ok", summary: "Pushed a fix." });
    }
  };
  const verdict = async (pull: Pull, body: string, state = "changes_requested") => {
    await submitReview(app, sentinel, fresh(), pull, {
      state: state as "changes_requested",
      body,
    });
    await settle();
  };
  const handoverNotes = (pull: Pull) =>
    listComments(app.db, pull.id).filter((c) =>
      c.body.startsWith("Handed to a person by the crew:"),
    );

  test("the hand-over note quotes each review up to 600 characters, cut at a sentence end, with its line comments", async () => {
    const set = await updateRepoSettings(app, alice, fresh(), {
      autonomy: "autonomous",
      autonomyCeilingUsd: 100,
      autonomyBy: alice.id,
    });
    if (!set.ok) throw new Error(JSON.stringify(set.error));
    const pull = await masonPull("quotes");
    const sentence = "The token is logged on every retry and must not be. ";
    const long = sentence.repeat(18).trim(); // ~900 characters
    expect(long.length).toBeGreaterThan(850);
    addReviewComment(app.db, {
      pullId: pull.id,
      authorId: sentinel.id,
      body: `<b>log</b> ${"x".repeat(300)}`,
      path: "src/auth.ts",
      line: 42,
      side: "new",
      commitOid: "",
      lineHash: "",
    });
    await verdict(pull, long);
    settleFeedback(pull);
    await verdict(pull, "Round two.");
    settleFeedback(pull);
    await verdict(pull, "Round three.");
    const body = handoverNotes(pull)[0]!.body;
    const quote = body
      .split("\n")
      .filter((l) => l.startsWith("> The token"))
      .join("");
    expect(quote.length).toBeLessThanOrEqual(602);
    expect(quote.length).toBeGreaterThan(500);
    expect(quote.endsWith("retry and must not be.")).toBe(true);
    const line = body.split("\n").find((l) => l.startsWith("- src/auth.ts:42: "))!;
    expect(line).toBeDefined();
    expect(line.length).toBe("- src/auth.ts:42: ".length + 200);
    expect(line).toContain("<b>log</b>");
    expect(body).toContain("> Round two.");
    expect(body).toContain("> Round three.");
    // Out of the way of the tests after it, which count open hand-overs.
    await setIssueState(app, alice, fresh(), getIssueById(app.db, pull.id)!, "closed");
  });

  test("the third changes-requested hands the pull to a person; a fourth queues nothing", async () => {
    const set = await updateRepoSettings(app, alice, fresh(), {
      autonomy: "autonomous",
      autonomyCeilingUsd: 100,
      autonomyBy: alice.id,
    });
    if (!set.ok) throw new Error(JSON.stringify(set.error));
    const pull = await masonPull("rounds");
    await verdict(pull, "Round one: the token is logged.");
    expect(feedback(pull).length).toBe(1);
    settleFeedback(pull);
    await verdict(pull, "Round two: still logged.");
    expect(feedback(pull).length).toBe(2);
    settleFeedback(pull);
    expect(handoverNotes(pull).length).toBe(0);
    await verdict(pull, "Round three: and the retry loops.");
    expect(feedback(pull).length).toBe(2);
    const notes = handoverNotes(pull);
    expect(notes.length).toBe(1);
    expect(notes[0]!.body).toContain("1. sentinel:\n\n> Round one");
    expect(notes[0]!.body).toContain("3. sentinel:\n\n> Round three");
    expect(notes[0]!.body).toContain("planner");
    // Not parked, not closed: still open, and the planner's, not a person's (#1655).
    expect(getIssueById(app.db, pull.id)!.state).toBe("open");
    expect(askLinesFor(app.db, alice).filter((a) => a.kind === "handover")).toEqual([]);
    expect(handedOverPulls(app.db, fresh()).map((h) => h.number)).toContain(pull.number);
    // An assisted repository has no planner: the same hand-over asks a person.
    const assisted = await updateRepoSettings(app, alice, fresh(), { autonomy: "assisted" });
    if (!assisted.ok) throw new Error(JSON.stringify(assisted.error));
    const asked = askLinesFor(app.db, alice).filter((a) => a.kind === "handover");
    expect(asked.length).toBe(1);
    expect(asked[0]!.number).toBe(pull.number);
    expect(handedOverPulls(app.db, fresh())).toEqual([]);
    const back = await updateRepoSettings(app, alice, fresh(), { autonomy: "autonomous" });
    if (!back.ok) throw new Error(JSON.stringify(back.error));
    await verdict(pull, "Round four.");
    expect(feedback(pull).length).toBe(2);
    expect(handoverNotes(pull).length).toBe(1);
  });

  test("a person's own pull with a spent review loop still asks the owner: the planner's list is the crew's pulls only (#1655)", async () => {
    const pull = await masonPull("person-spent");
    await verdict(pull, "One.");
    settleFeedback(pull);
    await verdict(pull, "Two.");
    settleFeedback(pull);
    await verdict(pull, "Three.");
    expect(handedOverPulls(app.db, fresh()).map((h) => h.number)).toContain(pull.number);
    app.db.query("UPDATE issue SET author_id = ?2 WHERE id = ?1").run(pull.id, alice.id);
    expect(handedOverPulls(app.db, fresh()).map((h) => h.number)).not.toContain(pull.number);
    expect(
      askLinesFor(app.db, alice).some((a) => a.number === pull.number && a.kind === "handover"),
    ).toBe(true);
  });

  test("a person's comment resets the count", async () => {
    const pull = await masonPull("reset-comment");
    await verdict(pull, "One.");
    settleFeedback(pull);
    await verdict(pull, "Two.");
    settleFeedback(pull);
    await verdict(pull, "Three.");
    expect(handoverNotes(pull).length).toBe(1);
    addComment(app, alice, fresh(), getIssueById(app.db, pull.id)!, "Try the other way.");
    await settle();
    settleFeedback(pull);
    expect(askLinesFor(app.db, alice).some((a) => a.number === pull.number && a.kind === "handover")).toBe(false);
    const before = feedback(pull).length;
    await verdict(pull, "Four, a new first round.");
    expect(feedback(pull).length).toBe(before + 1);
  });

  test("changes-requested from someone who is not the crew's reviewer does not count", async () => {
    const pull = await masonPull("not-reviewer");
    for (const n of [1, 2, 3]) {
      await submitReview(app, alice, fresh(), pull, {
        state: "changes_requested",
        body: `A person's ${n}.`,
      });
      await settle();
    }
    expect(handoverOf(app.db, fresh(), pull.id)).toBeUndefined();
    expect(handoverNotes(pull).length).toBe(0);
  });

  test("an approval resets the count", async () => {
    const pull = await masonPull("reset-approval");
    await verdict(pull, "One.");
    settleFeedback(pull);
    await verdict(pull, "Two.");
    settleFeedback(pull);
    await verdict(pull, "Fine now.", "approved");
    await verdict(pull, "Three.");
    expect(handoverNotes(pull).length).toBe(0);
  });
  test("the hand-over card offers three words, a close and a way to speak; closing or approving ends it", async () => {
    const pull = await masonPull("card");
    await verdict(pull, "One.");
    settleFeedback(pull);
    await verdict(pull, "Two.");
    settleFeedback(pull);
    await updateRepoSettings(app, alice, fresh(), { autonomy: "assisted" });
    await verdict(pull, "Three.");
    expect(ASK_WORDS.handover.options).toEqual(["Tell them what to try", "Close it"]);
    expect(KIND_TIER.handover).toBeDefined();
    const ctx = {
      app,
      request: new Request("http://forge.test/"),
      url: new URL("http://forge.test/"),
      params: {},
      auth: { user: alice, scope: undefined, via: "session" },
      theme: undefined,
    } as Ctx;
    const card = decisionsFor(ctx, [fresh()]).find((d) => d.kind === "handover");
    expect(card?.pull?.number).toBe(pull.number);
    expect(card!.consequence.why).toBe(KIND_TIER.handover.why);
    expect(card!.says).toContain("Say what to try");
    expect(askLinesFor(app.db, alice).find((a) => a.kind === "handover")!.words).toEqual(ASK_WORDS.handover);
    const form = String(decisionForm(card!));
    expect(form).toContain(`/pulls/${pull.number}/state`);
    expect(form).toContain('value="closed"');
    const actions = String(decisionActions(ctx, card!));
    expect(actions).toContain("Tell them");
    expect(actions).toContain("Close");
    expect(actions).not.toContain("Approve");
    const ask = `handover:${pull.id}`;
    const raised = new Date(0).toISOString();
    expect(endOf(app.db, alice.id, ask, raised)).toBe("expired");
    await verdict(pull, "Fine now.", "approved");
    expect(askLinesFor(app.db, alice).some((a) => a.number === pull.number && a.kind === "handover")).toBe(false);
    await setIssueState(app, alice, fresh(), getIssueById(app.db, pull.id)!, "closed");
    expect(endOf(app.db, alice.id, ask, raised)).toBe("acted");
  });

  test("a comment that only looks like the hand-over note is not a director's word", async () => {
    const pull = await masonPull("note-lookalike");
    await verdict(pull, "One.");
    settleFeedback(pull);
    await verdict(pull, "Two.");
    settleFeedback(pull);
    await verdict(pull, "Three.");
    expect(handoverOf(app.db, fresh(), pull.id)).toBeDefined();
    const issue = getIssueById(app.db, pull.id)!;
    addComment(app, alice, fresh(), issue, `${HANDOVER_NOTE} pasted by the owner`);
    expect(handoverOf(app.db, fresh(), pull.id)).toBeDefined();
    addComment(app, alice, fresh(), issue, "Try the other way.");
    expect(handoverOf(app.db, fresh(), pull.id)).toBeUndefined();
  });

  test("the terminal's On you lists a handed-over pull, and x closes it", async () => {
    const pull = await masonPull("terminal-card");
    await verdict(pull, "One.");
    settleFeedback(pull);
    await verdict(pull, "Two.");
    settleFeedback(pull);
    await updateRepoSettings(app, alice, fresh(), { autonomy: "assisted" });
    await verdict(pull, "Three.");
    const first = askLinesFor(app.db, alice)
      .filter((a) => a.kind === "handover")
      .flatMap((a) => a.items)[0]!
      .slice("handover:".length);
    const terminal = headlessTerminal(200, 40);
    const { app: ui } = createForgeApp(
      app,
      { sshUsername: "alice", remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user: alice },
      { terminal, exitHooks: false },
    );
    ui.start();
    const press = async (key: string) => {
      ui.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
      await settleApp(ui);
    };
    await settleApp(ui);
    await press("tab");
    expect(ui.screen.toText()).toContain("handed over");
    expect(getIssueById(app.db, first)!.state).toBe("open");
    await press("x");
    await press("enter");
    expect(getIssueById(app.db, first)!.state).toBe("closed");
    ui.stop();
  });
});
