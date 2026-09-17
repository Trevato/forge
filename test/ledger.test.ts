/**
 * The decision ledger and the three decisions behind it: which issue next,
 * ship or show, try again or stop — each with a rule underneath and a fake
 * decider on top, and each written down with what came of it.
 */
import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
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
import { claimRun, createRun, finishRun, listRuns } from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { setCrewRole } from "../src/core/agents.ts";
import type { Answer, Decider, Questions } from "../src/crew/decide.ts";
import { driveRepo, landIfGreen } from "../src/crew/autonomy.ts";
import { retryOrStop } from "../src/crew/dispatch.ts";
import { serve, type Servers } from "../src/http/server.ts";

/** A decider that answers from a script: question name → choice. */
function scripted(answers: Record<string, string>): Decider & {
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
        out[key] = { choice, p: 0.8, probabilities };
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
  const decider = scripted(script);
  const fresh = () => getRepoById(app.db, repo.id)!;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-ledger-"));
    app = createApp({ dataDir, port: 0, decider });
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
    setCrewRole(app.db, repo.id, getUserByName(app.db, "atlas")!.id, "planner");
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

  test("ship or show: a shown pull with no reviewer on the crew lands anyway, once per head, and the ledger says so", async () => {
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

    // The decider says show; there is nobody on the crew to show it to, so
    // autonomous means autonomous: it lands, and the decision is recorded
    // with what came of it.
    script["land"] = "show";
    const calls = decider.seen.length;
    expect(await landIfGreen(app, fresh(), pull)).toBe(true);
    expect(getPull(app.db, repo.id, pull.number)?.mergedAt).not.toBeNull();
    expect(decider.seen.length).toBe(calls + 1);
    const shown = latestDecision(app.db, pull.id, "land")!;
    expect(shown.answer).toBe("show");
    expect((shown.state as { head: string }).head).toBe(pull.headOid);
    expect(shown.outcome).toBe("shipped");
    expect(
      listDecisions(app.db, repo.id, { kind: "land" }).filter(
        (d) => d.issueId === pull.id,
      ).length,
    ).toBe(1);
    // Never a question for a person in an autonomous repository.
    const { decisionsFor } = await import("../src/web/pages/studio.ts");
    const asks = decisionsFor(
      { app, auth: { user: alice, via: "session" } } as never,
      [fresh()],
    );
    expect(asks.some((d) => d.pull?.id === pull.id)).toBe(false);
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
    script["retry"] = "stop";
    expect(
      await retryOrStop(app, fresh(), pull, failed.id, pull.createdAt),
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
    script["land"] = "show";
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

  test("the reviewer's pass: a shown pull gets one review run; approval lands it; no reviewer means it lands", async () => {
    const { setCrewRole } = await import("../src/core/agents.ts");
    const { submitReview } = await import("../src/actions/pulls.ts");
    const made = await createAgent(app, alice, { username: "sentinel" });
    if (!made.ok) throw new Error(String(made.error));
    expect(addToCrew(app, alice, repo, "sentinel").ok).toBe(true);
    const sentinel = made.value.user;
    setCrewRole(app.db, repo.id, sentinel.id, "reviewer");

    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/checkout",
      base: "main",
      message: "Checkout",
      files: [
        { path: "checkout.ts", content: "export const checkout = true;\n" },
      ],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, scout, repo, {
      title: "Checkout",
      body: "Takes the money.",
      baseBranch: "main",
      headBranch: "feature/checkout",
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

    script["land"] = "show";
    expect(await landIfGreen(app, fresh(), pull)).toBe(false);
    const reviews = () =>
      listRuns(app.db, repo.id, { kind: "agent" }).filter(
        (r) => r.issueId === pull.id && r.reason === "review",
      );
    expect(reviews().length).toBe(1);
    expect(reviews()[0]!.actorId).toBe(sentinel.id);
    expect(reviews()[0]!.summary).toBe(`review at ${pull.headOid.slice(0, 7)}`);
    // Nothing for a person: the studio lists no look ask for it.
    const { decisionsFor } = await import("../src/web/pages/studio.ts");
    const asks = decisionsFor(
      { app, auth: { user: alice, via: "session" } } as never,
      [fresh()],
    );
    expect(asks.some((d) => d.pull?.id === pull.id)).toBe(false);
    // A second look queues nothing more.
    expect(await landIfGreen(app, fresh(), pull)).toBe(false);
    expect(reviews().length).toBe(1);

    // The reviewer approves: it lands, and the waiting review run is let go.
    const approved = await submitReview(
      app,
      sentinel,
      fresh(),
      getPull(app.db, repo.id, pull.number)!,
      {
        state: "approved",
        body: "Does what the direction asks; the preview takes a test card.",
      },
    );
    expect(approved.ok).toBe(true);
    expect(
      await landIfGreen(app, fresh(), getPull(app.db, repo.id, pull.number)!),
    ).toBe(true);
    expect(getPull(app.db, repo.id, pull.number)?.mergedAt).not.toBeNull();
    expect(reviews()[0]!.state).toBe("cancelled");

    // Without a reviewer on the crew, a shown pull lands: autonomous means autonomous.
    setCrewRole(app.db, repo.id, sentinel.id, "builder");
    const branch2 = await commitToBranch(app, alice, repo, {
      branch: "feature/receipts",
      base: "main",
      message: "Receipts",
      files: [
        { path: "receipts.ts", content: "export const receipts = true;\n" },
      ],
    });
    if (!branch2.ok) throw new Error(JSON.stringify(branch2.error));
    const opened2 = await openPull(app, scout, repo, {
      title: "Receipts",
      baseBranch: "main",
      headBranch: "feature/receipts",
    });
    if (!opened2.ok) throw new Error(String(opened2.error));
    const check2 = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: opened2.value.id,
      env: `pull-${opened2.value.number}`,
      commitOid: opened2.value.headOid,
      reason: "pull",
    });
    claimRun(app.db, check2.id);
    finishRun(app.db, check2.id, { state: "ok", summary: "check passed" });
    expect(await landIfGreen(app, fresh(), opened2.value)).toBe(true);
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
