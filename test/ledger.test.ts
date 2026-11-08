/**
 * The decision ledger and the three decisions behind it: which issue next,
 * ship or show, try again or stop — each with a rule underneath and a fake
 * decider on top, and each written down with what came of it.
 */
import { quietWeek } from "./helpers/week-quiet.ts";
import { seatAs } from "./helpers/seat.ts";
import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { addComment, openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import {
  updateRepoSettings,
  getRepoById,
  type Repo,
} from "../src/core/repos.ts";
import {
  decisionStats,
  latestDecision,
  listDecisions,
  recordDecision,
  resolveOpen,
} from "../src/core/decisions.ts";
import { getIssueById, type Issue } from "../src/core/issues.ts";
import { getPull } from "../src/core/pulls.ts";
import { submitReview } from "../src/core/reviews.ts";
import { provideChecksForTest, type ChecksHandle } from "../src/checks/service.ts";
import { claimRun, createRun, finishRun, listRuns } from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import {} from "../src/core/agents.ts";
import type { Answer, Decider, Questions } from "../src/crew/decide.ts";
import { driveRepo, landIfGreen } from "../src/crew/autonomy.ts";
import { summariseCheckFailure } from "../src/checks/summary.ts";
import { answerFailedCheck, judgeFailedCheck } from "../src/crew/dispatch.ts";
import { serve, type Servers } from "../src/http/server.ts";

/** A decider that answers from a script: question name → choice. */
function scripted(
  answers: Record<string, string>,
  sureness: Record<string, number> = {},
): Decider & {
  seen: unknown[];
} {
  const seen: unknown[] = [];
  return {
    name: "scripted",
    seen,
    async decide<Q extends Questions>(state: unknown, questions: Q) {
      seen.push(state);
      const out: Record<string, Answer> = {};
      for (const [key, q] of Object.entries(questions)) {
        const choice = answers[key] ?? q.options[0]!;
        const probabilities: Record<string, number> = {};
        for (const o of q.options) probabilities[o] = o === choice ? 0.8 : 0.2;
        out[key] = { choice, p: sureness[key] ?? 0.8, probabilities };
      }
      return out as { [K in keyof Q]: Answer };
    },
  };
}

describe("the decision ledger", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let scout: User;
  let repo: Repo;
  const script: Record<string, string> = {};
  const sure: Record<string, number> = {};
  const decider = scripted(script, sure);
  const fresh = () => getRepoById(app.db, repo.id)!;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-ledger-"));
    app = createApp({ dataDir, port: 0, decider });
    quietWeek(app.db);
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
      name: "shop",
      visibility: "private",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# shop\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    for (const name of ["scout", "atlas"]) {
      const agent = await createAgent(app, alice, { username: name });
      if (!agent.ok) throw new Error(String(agent.error));
      expect(addToCrew(app, alice, repo, name).ok).toBe(true);
    }
    scout = getUserByName(app.db, "scout")!;
    seatAs(app.db, repo.id, getUserByName(app.db, "atlas")!.id, "planner");
    updateRepoSettings(app.db, repo, {
      autonomy: "autonomous",
      autonomyDirection: "Sell one real thing end to end.",
      autonomyCeilingUsd: 20,
      autonomySlots: 1,
      autonomyBy: alice.id,
    });
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a decision is written down with its answer, and later with what came of it", () => {
    const d = recordDecision(app.db, {
      kind: "land",
      repoId: repo.id,
      state: { head: "abc" },
      answer: "ship",
      p: 0.9,
      by: "scripted",
      ms: 12,
    });
    expect(d.outcome).toBeNull();
    expect(latestDecision(app.db, "nobody", "land")).toBeUndefined();
    expect(listDecisions(app.db, repo.id).length).toBe(1);
    const stats = decisionStats(app.db, repo.id, "2000-01-01");
    expect(stats.find((s) => s.kind === "land")?.answers["ship"]).toBe(1);
    expect(stats.find((s) => s.kind === "land")?.decided).toBe(1);
  });

  test("which issue next: the decider picks among the ready few; the pick is recorded", async () => {
    const titles = ["Catalog", "Cart", "Checkout"];
    const issues: Issue[] = [];
    for (const title of titles) {
      const opened = openIssue(app, alice, repo, { title });
      if (!opened.ok) throw new Error(String(opened.error));
      issues.push(opened.value);
    }
    // Everything is ready; the rule would take the first. The decider says Cart.
    script["next"] = String(issues[1]!.number);
    expect(await driveRepo(app, fresh())).toBe("picked");
    const cart = getIssueById(app.db, issues[1]!.id)!;
    expect(cart.assigneeId).toBe(scout.id);
    const recorded = listDecisions(app.db, repo.id, { kind: "next" })[0]!;
    expect(recorded.answer).toBe(String(cart.number));
    expect(recorded.by).toBe("scripted");
    // Routing asks the decider too, after the pick; the pick's state is the
    // one with the ready list in it.
    const seen = decider.seen.find(
      (x) => typeof x === "object" && x !== null && "ready" in x,
    ) as { direction: string; ready: unknown[] };
    expect(seen.direction).toBe("Sell one real thing end to end.");
    expect(seen.ready.length).toBe(3);
  });

  test("green lands by rule, once per head, and the ledger says so", async () => {
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/pay",
      base: "main",
      message: "Take money",
      files: [{ path: "pay.ts", content: "export const pay = true;\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, scout, repo, {
      title: "Take money",
      body: "Stripe in test mode.",
      baseBranch: "main",
      headBranch: "feature/pay",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    const check = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: pull.id,
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
      reason: "pull",
    });
    claimRun(app.db, check.id);
    finishRun(app.db, check.id, { state: "ok", summary: "check passed" });
    // An agent's pull ships only once reviewed (#597): this crew has no
    // reviewer, so a person's approval of the head is the review.
    submitReview(app.db, {
      issueId: pull.id,
      authorId: alice.id,
      state: "approved",
      commitOid: pull.headOid,
    });

    // Nobody is asked: the decider is not called, and the pull lands.
    const calls = decider.seen.length;
    expect(await landIfGreen(app, fresh(), pull)).toBe(true);
    expect(getPull(app.db, repo.id, pull.number)?.mergedAt).not.toBeNull();
    expect(decider.seen.length).toBe(calls);
    const landed = latestDecision(app.db, pull.id, "land")!;
    expect(landed.answer).toBe("ship");
    expect(landed.by).toBe("rule");
    expect((landed.state as { head: string }).head).toBe(pull.headOid);
    expect(landed.outcome).toBe("shipped");
    expect(
      listDecisions(app.db, repo.id, { kind: "land" }).filter(
        (d) => d.issueId === pull.id,
      ).length,
    ).toBe(1);
  });

  test("try again or stop: the decider can stop before another run is spent; the next check is the outcome", async () => {
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/red",
      base: "main",
      message: "Red",
      files: [{ path: "red.ts", content: "export const red = 1;\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, scout, repo, {
      title: "Red",
      baseBranch: "main",
      headBranch: "feature/red",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    const failed = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: pull.id,
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
      reason: "pull",
    });
    claimRun(app.db, failed.id);
    finishRun(app.db, failed.id, {
      state: "failed",
      summary: "test failed: 1 of 9",
    });
    // A shard that ran out of temp space is the environment's, even when the decider would stop.
    const full = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: pull.id,
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
      reason: "pull",
    });
    claimRun(app.db, full.id);
    // The real parse of a log, not a summary written by hand.
    const said = summariseCheckFailure(
      ["SQLiteError: database or disk is full", "(fail) migrate > pins [3ms]", "(fail) test/a.test.ts > (unnamed) [1ms]", " 9 pass", " 2 fail"],
      "exit 1",
    );
    finishRun(app.db, full.id, { state: "failed", summary: said.summary, checkDetail: said.detail });
    script["retry"] = "stop";
    const judged = await judgeFailedCheck(app, fresh(), pull, full.id, pull.createdAt);
    expect(judged.cause).toBe("environment");
    expect(judged.retry).toBe("again");
    expect(
      (await judgeFailedCheck(app, fresh(), pull, failed.id, pull.createdAt))
        .retry,
    ).toBe("stop");
    const seen = decider.seen.at(-1) as {
      tries: number;
      limit: number;
      check: { summary: string };
    };
    expect(seen.check.summary).toBe("test failed: 1 of 9");
    expect(seen.limit).toBeGreaterThan(0);
    const stopped = latestDecision(app.db, pull.id, "retry")!;
    expect(stopped.answer).toBe("stop");
    // No run was queued.
    expect(
      listRuns(app.db, repo.id, { kind: "agent" }).some(
        (r) => r.issueId === pull.id,
      ),
    ).toBe(false);
    // The outcome: the next check on the pull.
    expect(resolveOpen(app.db, pull.id, "retry", "green")).toBe(true);
    expect(latestDecision(app.db, pull.id, "retry")?.outcome).toBe("green");
    expect(resolveOpen(app.db, pull.id, "retry", "green")).toBe(false);
  });

  test("stop is not the last word on a red check: the environment's fault runs it again, once per commit, before anything is parked", async () => {
    const { getAgentByName } = await import("../src/core/agents.ts");
    const scoutAgent = getAgentByName(app.db, "scout")!;
    // A stand-in lane: the retry is queued as the real one queues it, but no
    // check runs, so the verdict does not wait on this machine's load.
    provideChecksForTest(app, {
      request: async (r: Repo, env: string, commitOid: string, reason: string, issueId?: string) =>
        createRun(app.db, { repoId: r.id, kind: "check", issueId, env, commitOid, reason }),
    } as unknown as ChecksHandle);
    try {
      const branch = await commitToBranch(app, alice, repo, {
        branch: "feature/flaky",
        base: "main",
        message: "Flaky",
        files: [
          {
            path: "forge.json",
            content: `{"check": {"run": "test -f OK.md", "install": ""}}\n`,
          },
          { path: "OK.md", content: "ok\n" },
        ],
      });
      if (!branch.ok) throw new Error(JSON.stringify(branch.error));
      const opened = await openPull(app, scout, repo, {
        title: "Flaky",
        baseBranch: "main",
        headBranch: "feature/flaky",
      });
      if (!opened.ok) throw new Error(String(opened.error));
      const pull = opened.value;
      const red = (): string => {
        const run = createRun(app.db, {
          repoId: repo.id,
          kind: "check",
          issueId: pull.id,
          env: `pull-${pull.number}`,
          commitOid: pull.headOid,
          reason: "pull",
        });
        claimRun(app.db, run.id);
        finishRun(app.db, run.id, {
          state: "failed",
          summary: "(fail) a pull closed under a running agent [60000.50ms]",
        });
        return run.id;
      };
      const failure = {
        kind: "check",
        commitOid: pull.headOid,
        env: `pull-${pull.number}`,
        since: pull.createdAt,
      };
      const retries = (): number =>
        listRuns(app.db, repo.id, { kind: "check", limit: 50 }).filter(
          (r) => r.issueId === pull.id && r.reason === "retry",
        ).length;

      // A timeout in a file the change never touched, and the decider says
      // stop. Today that parked the pull on the spot; the cause is asked
      // first now, and it is the environment's — the check runs again.
      script["retry"] = "stop";
      script["cause"] = "environment";
      const asked = decider.seen.length;
      expect(
        await answerFailedCheck(app, fresh(), pull, scoutAgent, {
          runId: red(),
          ...failure,
        }),
      ).toBe("reran");
      // One decision, not two: whose fault and whether to try again come
      // back from the same round trip.
      expect(decider.seen.length).toBe(asked + 1);
      expect(getPull(app.db, repo.id, pull.number)?.state).toBe("open");
      expect(retries()).toBe(1);
      // The agent's tries are not spent: no rework was queued.
      expect(
        listRuns(app.db, repo.id, { kind: "agent" }).some(
          (r) => r.issueId === pull.id && r.reason === "check_failed",
        ),
      ).toBe(false);

      // Once per head commit: red again on the same commit goes back to its builder.
      // The decider's stop no longer parks; the try limit does.
      expect(
        await answerFailedCheck(app, fresh(), pull, scoutAgent, {
          runId: red(),
          ...failure,
        }),
      ).toBe("reworked");
      expect(getPull(app.db, repo.id, pull.number)?.state).toBe("open");

      // A full temp space on a commit is run again once; the same red on the
      // same commit is not run again, however often it comes (#8679).
      const second = await commitToBranch(app, alice, repo, {
        branch: "feature/full",
        base: "main",
        message: "Full",
        files: [
          { path: "forge.json", content: `{"check": {"run": "test -f OK.md", "install": ""}}\n` },
          { path: "OK.md", content: "ok\n" },
        ],
      });
      if (!second.ok) throw new Error(JSON.stringify(second.error));
      const reopened = await openPull(app, scout, repo, {
        title: "Full",
        baseBranch: "main",
        headBranch: "feature/full",
      });
      if (!reopened.ok) throw new Error(String(reopened.error));
      const filled = reopened.value;
      script["retry"] = "again";
      delete script["cause"];
      const fullRed = (): string => {
        const run = createRun(app.db, {
          repoId: repo.id,
          kind: "check",
          issueId: filled.id,
          env: `pull-${filled.number}`,
          commitOid: filled.headOid,
          reason: "pull",
        });
        claimRun(app.db, run.id);
        const said = summariseCheckFailure(["Error: database or disk is full", "(fail) a [1ms]", " 1 fail"], "exit 1");
        finishRun(app.db, run.id, { state: "failed", summary: said.summary, checkDetail: said.detail });
        return run.id;
      };
      const again = { kind: "check", commitOid: filled.headOid, env: `pull-${filled.number}`, since: filled.createdAt };
      const answers: string[] = [];
      for (let i = 0; i < 3; i++)
        answers.push(await answerFailedCheck(app, fresh(), filled, scoutAgent, { runId: fullRed(), ...again }));
      expect(answers).toEqual(["reran", "reworked", "reworked"]);
    } finally {
      delete script["cause"];
    }
    // Two git writes and an open pull: the verdict is the code's, so the clock
    // on a loaded check machine must not be the test's.
  }, 30_000);

  test("conflicts come first: a green pull that no longer merges gets a conflict run before anyone decides", async () => {
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/readme",
      base: "main",
      message: "Readme, the branch's way",
      files: [{ path: "README.md", content: "# shop, by the branch\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, scout, repo, {
      title: "Readme",
      baseBranch: "main",
      headBranch: "feature/readme",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    const moved = await commitToBranch(app, alice, repo, {
      branch: "main",
      message: "Readme, main's way",
      files: [{ path: "README.md", content: "# shop, by main\n" }],
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
    finishRun(app.db, check.id, { state: "ok", summary: "check passed" });
    const calls = decider.seen.length;
    expect(await landIfGreen(app, fresh(), pull)).toBe(false);
    // No decision was asked for: the conflict run came first.
    expect(decider.seen.length).toBe(calls);
    expect(latestDecision(app.db, pull.id, "land")).toBeUndefined();
    const conflict = listRuns(app.db, repo.id, { kind: "agent" }).find(
      (r) => r.issueId === pull.id && r.reason === "conflict",
    );
    expect(conflict?.summary).toBe("main moved: README.md");
    expect(conflict?.actorId).toBe(scout.id);
  });

  test("a repository on its own never waits: past its tries a pull is parked, its issue goes back on the map, and an issue parked twice is handed to the planner", async () => {
    const { parkPull, parkedCount } = await import("../src/crew/autonomy.ts");
    const { parkedTwice } = await import("../src/crew/parks.ts");
    const { listComments, getIssueById: issueById } =
      await import("../src/core/issues.ts");
    const work = openIssue(app, alice, repo, { title: "Gift cards" });
    if (!work.ok) throw new Error(String(work.error));
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/gift",
      base: "main",
      message: "Gift cards",
      files: [{ path: "gift.ts", content: "export const gift = 1;\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, scout, repo, {
      title: "Gift cards",
      body: `Closes #${work.value.number}`,
      baseBranch: "main",
      headBranch: "feature/gift",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    expect(
      parkPull(
        app,
        fresh(),
        opened.value,
        "the check stayed red through 2 automatic tries",
      ),
    ).toBe(true);
    expect(getPull(app.db, repo.id, opened.value.number)?.state).toBe("closed");
    const about = issueById(app.db, work.value.id)!;
    expect(about.state).toBe("open");
    expect(about.assigneeId).toBeNull();
    const notes = listComments(app.db, work.value.id).map((c) => c.body);
    expect(
      notes.some((b) =>
        b.startsWith("Parked by the crew: the check stayed red"),
      ),
    ).toBe(true);
    expect(parkedCount(app, fresh(), work.value.id)).toBe(1);
    // Parked once: the crew picks it again. Parked twice: never picked by
    // itself, and the planner's, with both reasons as the notes gave them.
    addComment(
      app,
      alice,
      repo,
      about,
      "Parked by the crew: main moved under it twice",
    );
    expect(parkedCount(app, fresh(), work.value.id)).toBe(2);
    script["next"] = String(work.value.number);
    await driveRepo(app, fresh());
    expect(issueById(app.db, work.value.id)?.assigneeId).toBeNull();
    expect(
      parkedTwice(app.db, [fresh()]).find((i) => i.number === work.value.number)
        ?.reasons,
    ).toEqual([
      `the check stayed red through 2 automatic tries (pull #${opened.value.number} closed)`,
      "main moved under it twice",
    ]);
    // Not a question for a person, in either case.
  });

  test("a review run never fills a slot, and a builder's run that ends without a pull parks its issue for one fresh try", async () => {
    const { settleAgentRun, parkedCount } =
      await import("../src/crew/autonomy.ts");
    const { getIssueById: issueById } = await import("../src/core/issues.ts");
    // A queued review run on some pull, one slot: the next issue is still picked.
    const work = openIssue(app, alice, repo, { title: "Wishlist" });
    if (!work.ok) throw new Error(String(work.error));
    const anyPull = listRuns(app.db, repo.id, { kind: "agent" }).find(
      (r) => r.issueId !== null && r.actorId !== null,
    );
    expect(anyPull).toBeDefined();
    const busy = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: anyPull!.issueId!,
      actorId: anyPull!.actorId!,
      reason: "review",
    });
    void busy;
    script["next"] = String(work.value.number);
    // Exactly as many slots as builders' runs already in flight: the
    // review run above would make it "full" if it counted.
    const builders = listRuns(app.db, repo.id, { kind: "agent" }).filter(
      (r) =>
        (r.state === "queued" || r.state === "running") &&
        r.reason !== "review",
    ).length;
    updateRepoSettings(app.db, fresh(), { autonomySlots: builders + 1 });
    // Seven hours on, the governor's flow windows hold nothing: this is about slots, not the pile (#6375).
    const later = new Date(Date.now() + 7 * 3_600_000);
    expect(await driveRepo(app, fresh(), later)).toBe("picked");
    expect(issueById(app.db, work.value.id)?.assigneeId).toBe(scout.id);

    // The builder's run ends with nothing pushed: parked, unassigned. (No
    // crew runs here, so the run row is made by hand.)
    const done = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: work.value.id,
      actorId: scout.id,
      reason: "assigned",
    });
    claimRun(app.db, done.id);
    finishRun(app.db, done.id, {
      state: "ok",
      summary: "no changes pushed: DECLINED: out of scope",
    });
    expect(
      settleAgentRun(app, fresh(), {
        issueId: work.value.id,
        state: "ok",
        summary: "no changes pushed: DECLINED: out of scope",
        reason: "assigned",
        actorId: scout.id,
      }),
    ).toBe(true);
    expect(issueById(app.db, work.value.id)?.assigneeId).toBeNull();
    expect(parkedCount(app, fresh(), work.value.id)).toBe(1);
    // A run that opened a pull parks nothing.
    expect(
      settleAgentRun(app, fresh(), {
        issueId: work.value.id,
        state: "ok",
        summary: "opened pull #99",
        reason: "assigned",
        actorId: scout.id,
      }),
    ).toBe(false);
    updateRepoSettings(app.db, fresh(), { autonomySlots: 2 });
  });

  test("the ceiling gates every run the crew starts on its own; a person's assignment is not the crew's", async () => {
    const { queueAgentRun } = await import("../src/crew/dispatch.ts");
    const { getAgentByName } = await import("../src/core/agents.ts");
    const work = openIssue(app, alice, repo, { title: "Loyalty points" });
    if (!work.ok) throw new Error(String(work.error));
    const scoutAgent = getAgentByName(app.db, "scout")!;
    updateRepoSettings(app.db, fresh(), { autonomyCeilingUsd: 0 });
    // At the ceiling: no feedback run.
    expect(
      queueAgentRun(app, fresh(), work.value, scoutAgent, "feedback"),
    ).toBeUndefined();
    // A person's assignment still runs.
    expect(
      queueAgentRun(app, fresh(), work.value, scoutAgent, "assigned"),
    ).toBeDefined();
    updateRepoSettings(app.db, fresh(), { autonomyCeilingUsd: 20 });
  });

  test("the ledger is on the API, newest first, with the week per kind", async () => {
    const { createToken } = await import("../src/core/tokens.ts");
    const token = createToken(app.db, alice.id, "ledger", "ro");
    const res = await fetch(
      `${servers.url}/api/v1/repos/alice/shop/decisions`,
      {
        headers: { authorization: `Bearer ${token.token}` },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      decisions: { kind: string }[];
      week: { kind: string; n: number }[];
    };
    expect(body.decisions.length).toBeGreaterThanOrEqual(3);
    expect(body.week.map((w) => w.kind).sort()).toEqual([
      "land",
      "next",
      "retry",
    ]);
  });
});
