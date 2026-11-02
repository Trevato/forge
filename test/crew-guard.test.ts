/**
 * Runs the crew can already see are waste are not started (#807). A
 * follow-up with nothing new since the agent's last run — its own reply is
 * the newest word — is skipped before it is queued, and again as a queued
 * one starts; an issue that started its day's share of runs without a
 * person's word is parked once and asked about once; a reader's word
 * re-arms neither the cap nor the breaker. The clock does not give the
 * planner the direction again when nobody spoke and the map has not moved
 * since its last pass (#1097). Each skip and cap is counted for the
 * token-return view.
 */
import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import {
  addComment,
  assignIssue,
  openIssue,
} from "../src/actions/issues.ts";
import {
  commitToBranch,
  createRepo,
  updateRepoSettings,
} from "../src/actions/repos.ts";
import { readUsage } from "../src/actions/usage.ts";
import { getAgent, type Agent } from "../src/core/agents.ts";
import { listDecisions } from "../src/core/decisions.ts";
import {
  getIssueById,
  listComments,
  markHeard,
  type Issue,
} from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import {
  cancelRun,
  claimRun,
  createRun,
  finishRun,
  getRun,
  listRuns,
} from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { driveRepo } from "../src/crew/autonomy.ts";
import { breakerParked, breakerTripped } from "../src/crew/breaker.ts";
import { queueAgentRun } from "../src/crew/dispatch.ts";
import {
  CAP_NOTE,
  guardCounts,
  ISSUE_RUN_CAP,
  SKIP_SUMMARY,
} from "../src/crew/guard.ts";
import { executeAgentRun } from "../src/crew/runner.ts";
import { feedbackSince, newsSince } from "../src/crew/news.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let alice: User;
let mallory: User;
let bot: Agent;
let repo: Repo;
let made = 0;

const ok = <T>(
  r: { ok: true; value: T } | { ok: false; error: unknown },
): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const fresh = (): Repo => getRepoById(app.db, repo.id)!;
const runsOn = (issue: Issue) =>
  listRuns(app.db, repo.id, { kind: "agent" }).filter(
    (r) => r.issueId === issue.id,
  );
const guards = (answer: string) =>
  listDecisions(app.db, repo.id, { kind: "guard" }).filter(
    (d) => d.answer === answer,
  ).length;

/** A finished run of the bot on `issue`; its reply, when given, is posted after it. */
function ran(
  issue: Issue,
  reply?: string,
  state: "ok" | "failed" = "ok",
  reason = "assigned",
) {
  const run = createRun(app.db, {
    repoId: repo.id,
    kind: "agent",
    issueId: issue.id,
    actorId: bot.user.id,
    reason,
  });
  claimRun(app.db, run.id);
  finishRun(app.db, run.id, {
    state,
    summary: state === "ok" ? "answered" : "declined: no",
    costUsd: 0.5,
  });
  // Runs on one issue are spread past the repeat stop's ten minutes (#8707), so
  // the cap and the breaker, which these tests are about, are what they meet.
  const before = runsOn(issue).length - 1;
  app.db
    .query("UPDATE run SET created_at = ?1 WHERE id = ?2")
    .run(new Date(Date.now() - before * 11 * 60_000).toISOString(), run.id);
  if (reply !== undefined) ok(addComment(app, bot.user, repo, issue, reply));
}

/** An issue of alice's, held by the bot. */
function held(title: string): Issue {
  const issue = ok(
    openIssue(app, alice, fresh(), { title: `${title} ${++made}` }),
  );
  // Held without a run starting: the assignment is the row, not the event.
  app.db
    .query("UPDATE issue SET assignee_id = ?1 WHERE id = ?2")
    .run(bot.user.id, issue.id);
  return getIssueById(app.db, issue.id)!;
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-guard-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  alice = ok(
    await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    }),
  );
  mallory = ok(
    await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "mallory",
      email: "mallory@forge.local",
      password: "a-good-passphrase",
    }),
  );
  ok(await createAgent(app, alice, { username: "bot" }));
  repo = ok(
    await createRepo(app, alice, { name: "square", visibility: "public" }),
  );
  expect(addToCrew(app, alice, repo, "bot").ok).toBe(true);
  bot = getAgent(app.db, getUserByName(app.db, "bot")!.id)!;
}, 30_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("a follow-up with nothing new is not started", () => {
  test("when the newest word is the agent's own reply, nothing is queued and the skip is recorded", () => {
    const issue = held("Paint the fence");
    ok(addComment(app, alice, repo, issue, "White, please."));
    ran(issue, "Painted it white.");
    const before = guards("skipped");
    expect(
      queueAgentRun(app, fresh(), issue, bot, "feedback", alice.id),
    ).toBeUndefined();
    expect(runsOn(issue).filter((r) => r.state === "queued")).toEqual([]);
    expect(guards("skipped")).toBe(before + 1);
  });

  test("a person's word after the last run is news: the follow-up is queued", async () => {
    const issue = held("Paint the gate");
    ran(issue, "Done.");
    await Bun.sleep(5);
    ok(addComment(app, alice, repo, issue, "Now the gate."));
    const queued = queueAgentRun(app, fresh(), issue, bot, "feedback", alice.id);
    expect(queued?.state).toBe("queued");
  });

  test("a word said while a run worked, and could not be steered into it, is heard by the next", async () => {
    const issue = held("Paint the porch");
    // The run begins and reads its brief…
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: issue.id,
      actorId: bot.user.id,
      reason: "assigned",
    });
    claimRun(app.db, run.id);
    await Bun.sleep(5);
    // …a person speaks while it works, and the session cannot hear it…
    ok(addComment(app, alice, repo, issue, "Blue, not green."));
    await Bun.sleep(5);
    // …and it ends with its own reply after the word.
    finishRun(app.db, run.id, { state: "ok", summary: "answered", costUsd: 0.5 });
    ok(addComment(app, bot.user, repo, issue, "Painted it green."));
    const queued = queueAgentRun(app, fresh(), issue, bot, "feedback", alice.id);
    expect(queued?.state).toBe("queued");
    // The brief the next run reads quotes it.
    const news = newsSince({
      comments: listComments(app.db, issue.id, { kind: "comment" }),
      reviews: [],
      reviewComments: [],
      since: feedbackSince(app.db, fresh(), getIssueById(app.db, issue.id)!, bot),
      agentName: "bot",
    });
    expect(news.comments.map((c) => c.body)).toEqual(["Blue, not green."]);
  });

  test("a word steered into the run that worked is told once: not again to the next", async () => {
    const issue = held("Paint the roof");
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: issue.id,
      actorId: bot.user.id,
      reason: "assigned",
    });
    claimRun(app.db, run.id);
    await Bun.sleep(5);
    // Said while it worked: one heard by steering, one not.
    const steered = ok(addComment(app, alice, repo, issue, "Red."));
    markHeard(app.db, steered.id, run.id);
    finishRun(app.db, run.id, { state: "ok", summary: "answered", costUsd: 0.5 });
    const current = getIssueById(app.db, issue.id)!;
    // Only the steered word since: nothing new, nothing queued.
    expect(queueAgentRun(app, fresh(), current, bot, "feedback", alice.id)).toBeUndefined();
    const unheard = ok(addComment(app, alice, repo, issue, "And the door."));
    const news = newsSince({
      comments: listComments(app.db, issue.id, { kind: "comment" }),
      reviews: [],
      reviewComments: [],
      since: feedbackSince(app.db, fresh(), current, bot),
      agentName: "bot",
    });
    expect(news.comments.map((c) => c.id)).toEqual([unheard.id]);
  });

  test("a word steered into a run that then failed or was cut short is news again", async () => {
    for (const ending of ["failed", "cancelled"] as const) {
      const issue = held(`Paint the fence ${ending}`);
      const run = createRun(app.db, {
        repoId: repo.id,
        kind: "agent",
        issueId: issue.id,
        actorId: bot.user.id,
        reason: "assigned",
      });
      claimRun(app.db, run.id);
      await Bun.sleep(5);
      const steered = ok(addComment(app, alice, repo, issue, `Blue (${ending}).`));
      markHeard(app.db, steered.id, run.id);
      if (ending === "failed")
        finishRun(app.db, run.id, { state: "failed", summary: "the run failed", costUsd: 0.1 });
      else cancelRun(app.db, run.id, "interrupted by a restart");
      const current = getIssueById(app.db, issue.id)!;
      const queued = queueAgentRun(app, fresh(), current, bot, "feedback", alice.id);
      expect({ ending, queued: queued?.state }).toEqual({ ending, queued: "queued" });
      const news = newsSince({
        comments: listComments(app.db, issue.id, { kind: "comment" }),
        reviews: [],
        reviewComments: [],
        since: feedbackSince(app.db, fresh(), current, bot),
        agentName: "bot",
      });
      expect(news.comments.map((c) => c.id)).toEqual([steered.id]);
    }
  });

  test("a follow-up queued behind a run that answered everything ends as it starts, at no cost", async () => {
    const issue = held("Paint the shed");
    ok(addComment(app, alice, repo, issue, "Green."));
    // Queued while an earlier run worked; that run heard the word and ended after it.
    const queued = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: issue.id,
      actorId: bot.user.id,
      reason: "feedback",
    });
    ran(issue, "Painted it green.");
    await executeAgentRun(app, getRun(app.db, queued.id)!, {
      forgeUrl: servers.url,
      localUrl: servers.url,
      binary: "/nonexistent/claude",
      concurrency: 1,
      budgetUsd: 1,
      runTimeoutMs: 1000,
    } as never);
    const after = getRun(app.db, queued.id)!;
    expect(after.state).toBe("cancelled");
    expect(after.summary).toBe(SKIP_SUMMARY);
    expect(after.costUsd).toBe(0);
  });
});

describe("an issue cannot loop", () => {
  test("past its day's runs it is parked once, asked about once, and a reader's word re-arms nothing", () => {
    const issue = held("Rounder corners");
    for (let n = 0; n < ISSUE_RUN_CAP; n++) ran(issue);
    const before = guards("capped");
    expect(
      queueAgentRun(app, fresh(), issue, bot, "assigned", alice.id),
    ).toBeUndefined();
    expect(
      queueAgentRun(app, fresh(), issue, bot, "assigned", alice.id),
    ).toBeUndefined();
    const notes = listComments(app.db, issue.id).filter(
      (c) => c.body === CAP_NOTE,
    );
    expect(notes).toHaveLength(1);
    expect(guards("capped")).toBe(before + 1);
    expect(
      breakerParked(app.db, [repo.id]).filter((p) => p.issueId === issue.id),
    ).toHaveLength(1);

    // A reader speaks: still capped, and still the one park.
    ok(addComment(app, mallory, repo, issue, "Try again!"));
    expect(
      queueAgentRun(app, fresh(), issue, bot, "assigned", alice.id),
    ).toBeUndefined();
    expect(
      listComments(app.db, issue.id).filter((c) => c.body === CAP_NOTE),
    ).toHaveLength(1);
    expect(guards("capped")).toBe(before + 1);
    // A person who may direct the crew speaks: it runs again.
    ok(addComment(app, alice, repo, issue, "Smaller radius."));
    expect(
      queueAgentRun(app, fresh(), issue, bot, "assigned", alice.id)?.state,
    ).toBe("queued");
  });

  test("a reviewer's runs on a pull are not the loop the cap counts", () => {
    const issue = held("Sharper icons");
    for (let n = 0; n < ISSUE_RUN_CAP - 1; n++) {
      ran(issue);
      ran(issue, undefined, "ok", "review");
    }
    expect(
      queueAgentRun(app, fresh(), issue, bot, "assigned", alice.id)?.state,
    ).toBe("queued");
  });

  test("bringing a pull up to main and answering its red check are bounded on their own, not by the cap", () => {
    const issue = held("Quieter toasts");
    for (let n = 0; n < ISSUE_RUN_CAP - 1; n++) {
      ran(issue, undefined, "ok", "feedback");
      ran(issue, undefined, "ok", "conflict");
      ran(issue, undefined, "ok", "check_failed");
    }
    const before = guards("capped");
    expect(
      queueAgentRun(app, fresh(), issue, bot, "assigned", alice.id)?.state,
    ).toBe("queued");
    expect(guards("capped")).toBe(before);
  });

  test("the agent's own starts still reach the cap", () => {
    const issue = held("Louder toasts");
    ran(issue);
    for (let n = 1; n < ISSUE_RUN_CAP; n++) {
      ran(issue, undefined, "ok", "feedback");
      ran(issue, undefined, "ok", "conflict");
    }
    expect(
      queueAgentRun(app, fresh(), issue, bot, "assigned", alice.id),
    ).toBeUndefined();
  });

  test("the cap is a setting", () => {
    const issue = held("Softer shadow");
    ran(issue);
    ran(issue);
    app.config.issueRunCap = 2;
    try {
      expect(
        queueAgentRun(app, fresh(), issue, bot, "assigned", alice.id),
      ).toBeUndefined();
    } finally {
      delete app.config.issueRunCap;
    }
  });

  test("the breaker: a reader's word does not lift it; a writer's does", async () => {
    const issue = held("Faster square");
    for (let n = 0; n < 3; n++) ran(issue, undefined, "failed");
    // Words come after the runs, never in the same millisecond.
    await Bun.sleep(5);
    expect(breakerTripped(app.db, fresh(), issue.id)).toBe(true);
    ok(addComment(app, mallory, repo, issue, "Go on."));
    expect(breakerTripped(app.db, fresh(), issue.id)).toBe(true);
    ok(addComment(app, alice, repo, issue, "Use a cache."));
    expect(breakerTripped(app.db, fresh(), issue.id)).toBe(false);
  });
});

describe("the planner is not given the direction again with nothing new (#1097)", () => {
  test("its own summary, posted as its run ends, starts nothing; a person's word does", async () => {
    const atlas = ok(await createAgent(app, alice, { username: "atlas" }));
    const round = ok(
      await createRepo(app, alice, { name: "round", visibility: "public" }),
    );
    ok(
      await commitToBranch(app, alice, round, {
        message: "Start",
        files: [{ path: "README.md", content: "# round\n" }],
      }),
    );
    for (const name of ["bot", "atlas"])
      expect(addToCrew(app, alice, round, name).ok).toBe(true);
    seatAs(app.db, round.id, atlas.user.id, "planner");
    ok(
      await updateRepoSettings(app, alice, round, {
        autonomy: "autonomous",
        autonomyDirection: "Make the square rounder.",
        autonomyCeilingUsd: 10,
        autonomySlots: 2,
        autonomyBy: alice.id,
      }),
    );
    const now = (): Repo => getRepoById(app.db, round.id)!;
    const skips = () =>
      listDecisions(app.db, round.id, { kind: "guard" }).filter(
        (d) => d.answer === "skipped",
      ).length;
    // The map is dry: the clock gives the planner the direction.
    expect(await driveRepo(app, now())).toBe("planned");
    const direction = getIssueById(app.db, now().directionIssueId!)!;
    expect(direction.assigneeId).toBe(atlas.user.id);
    // Its pass: it reads, posts its summary as it ends, and lets go.
    const pass = createRun(app.db, {
      repoId: round.id,
      kind: "agent",
      issueId: direction.id,
      actorId: atlas.user.id,
      reason: "assigned",
    });
    claimRun(app.db, pass.id);
    await Bun.sleep(5);
    ok(addComment(app, atlas.user, now(), direction, "I linked the map."));
    finishRun(app.db, pass.id, { state: "ok", summary: "planned", costUsd: 0.5 });
    ok(assignIssue(app, alice, now(), direction, null));
    // Its own summary is no news: no follow-up is queued on it…
    const unheld = getIssueById(app.db, direction.id)!;
    expect(
      queueAgentRun(app, now(), unheld, atlas, "feedback", alice.id),
    ).toBeUndefined();
    // …and the clock, past its interval, does not give it the direction
    // again. The skip is the rule's, recorded once however often it asks.
    const later = new Date(Date.now() + 30 * 60_000);
    const before = skips();
    expect(await driveRepo(app, now(), later)).not.toBe("planned");
    expect(await driveRepo(app, now(), later)).not.toBe("planned");
    expect(getIssueById(app.db, direction.id)!.assigneeId).toBeNull();
    expect(skips()).toBe(before + 1);
    const skip = listDecisions(app.db, round.id, { kind: "guard" }).find((d) =>
      JSON.stringify(d.state).includes("replan"),
    )!;
    expect(skip.by).toBe("rule");
    expect(skip.issueId).toBe(direction.id);
    // A person's word on the direction is news: it is given again.
    await Bun.sleep(5);
    ok(addComment(app, alice, now(), unheld, "Rounder means radius 8."));
    expect(await driveRepo(app, now(), later)).toBe("planned");
    expect(getIssueById(app.db, direction.id)!.assigneeId).toBe(atlas.user.id);
  });
});

describe("what the guard saved is counted", () => {
  test("skips and caps reach the usage report", () => {
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const counts = guardCounts(app.db, repo.id, since);
    expect(counts.skipped).toBeGreaterThanOrEqual(2);
    expect(counts.capped).toBeGreaterThanOrEqual(2);
    const usage = ok(readUsage(app, alice, fresh(), 1));
    expect(usage.guard).toEqual(counts);
    // Counted, not listed one by one where a person reads decisions.
    expect(guards("skipped")).toBe(counts.skipped);
  });
});

