import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { listActive, type RunKind } from "../src/core/runs.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { claimRun, createRun, getRun } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";
import { INTERRUPTED_OUT, MAX_INTERRUPTIONS, interruptionBackoffMs, requeue, requeueInterrupted } from "../src/crew/dispatch.ts";
import { daySpent } from "../src/core/account_ceiling.ts";
import { noteRunProgress } from "../src/core/runs.ts";
import { recordUsage, usageTotals } from "../src/core/usage.ts";
import { STALE_AFTER_MS } from "../src/runs/lease.ts";
import type { User } from "../src/core/users.ts";

/** Every queued run of one kind, those still waiting out a backoff included. */
const queuedIncludingWaiting = (db: Database, kind: RunKind) => listActive(db, kind).filter((r) => r.state === "queued");

describe("a run a restart cuts off", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let bot: User;
  let n = 0;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-interrupted-out-"));
    app = createApp({ dataDir, port: 0 });
    const a = await createUser(app.db, {
      origin: "seed", trusted: true, username: "alice",
      email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createAgent(app, alice, { username: "bot" });
    if (!made.ok) throw new Error(String(made.error));
    bot = made.value.user;
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** A queued run on a fresh issue, claimed and its lease lapsed. */
  const setup = async () => {
    const created = await createRepo(app, alice, { name: `r${n++}`, visibility: "private" });
    if (!created.ok) throw new Error(String(created.error));
    expect(addToCrew(app, alice, created.value, "bot").ok).toBe(true);
    const issued = openIssue(app, alice, created.value, { title: "Plant", body: "" });
    if (!issued.ok) throw new Error(String(issued.error));
    const run = createRun(app.db, {
      repoId: created.value.id, kind: "agent", issueId: issued.value.id,
      actorId: bot.id, reason: "feedback",
    });
    return { issue: issued.value, run };
  };
  const lapse = (id: string) => {
    claimRun(app.db, id);
    app.db
      .query("UPDATE run SET heartbeat_at = ?2 WHERE id = ?1")
      .run(id, new Date(Date.now() - STALE_AFTER_MS - 1_000).toISOString());
  };
  const forIssue = (issueId: string) => queuedIncludingWaiting(app.db, "agent").filter((r) => r.issueId === issueId);

  test("once: cancelled and queued again", async () => {
    const { issue, run } = await setup();
    lapse(run.id);
    requeueInterrupted(app);
    expect(getRun(app.db, run.id)!.state).toBe("cancelled");
    const again = forIssue(issue.id);
    expect(again.length).toBe(1);
    expect(again[0]!.summary).toStartWith("interrupted by a restart; queued again");
  });

  test("each interruption is counted as data and waits 15 s doubling to 4 min", async () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(interruptionBackoffMs)).toEqual([15_000, 30_000, 60_000, 120_000, 240_000, 240_000, 240_000]);
    const { issue, run } = await setup();
    let cur = run;
    for (let i = 1; i <= MAX_INTERRUPTIONS; i++) {
      lapse(cur.id);
      const lo = Date.now();
      requeueInterrupted(app);
      const hi = Date.now();
      expect(getRun(app.db, cur.id)!.state).toBe("cancelled");
      cur = forIssue(issue.id)[0]!;
      expect(cur.interruptions).toBe(i);
      const due = Date.parse(cur.notBefore!);
      expect(due).toBeGreaterThanOrEqual(lo + interruptionBackoffMs(i));
      expect(due).toBeLessThanOrEqual(hi + interruptionBackoffMs(i));
    }
  });

  test("a graceful stop leaves the count and the wait alone, even past the budget", async () => {
    const { issue, run } = await setup();
    app.db.query("UPDATE run SET interruptions = ?2 WHERE id = ?1").run(run.id, MAX_INTERRUPTIONS);
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    requeue(app, getRun(app.db, run.id)!, "stopped for a restart; queued again", false, now);
    expect(getRun(app.db, run.id)!.state).toBe("cancelled");
    const again = forIssue(issue.id);
    expect(again).toHaveLength(1);
    expect(again[0]!.interruptions).toBe(MAX_INTERRUPTIONS);
    expect(again[0]!.notBefore).toBe(new Date(now).toISOString());
  });

  test("the sixth interruption fails the run with its reason, nothing queued", async () => {
    const { issue, run } = await setup();
    app.db.query("UPDATE run SET interruptions = ?2 WHERE id = ?1").run(run.id, MAX_INTERRUPTIONS);
    lapse(run.id);
    requeueInterrupted(app);
    const after = getRun(app.db, run.id)!;
    expect(after.state).toBe("failed");
    expect(after.summary).toBe(INTERRUPTED_OUT);
    expect(forIssue(issue.id)).toEqual([]);
  });

  test("an interruption is charged once: the sum of each run's own spend", async () => {
    const { issue, run } = await setup();
    const at = () => new Date().toISOString();
    const line = (id: string, costUsd: number, outcome: "running" | "ok") =>
      recordUsage(app.db, {
        runId: id, repoId: run.repoId, issueId: issue.id, agentId: bot.id,
        subscriptionId: null, kind: "build", tokensIn: 10, tokensOut: 5,
        costUsd, wallMs: 1000, outcome, at: at(),
      });
    const owed = () =>
      usageTotals(app.db, "issue", { since: "1970-01-01T00:00:00.000Z", repoId: run.repoId })
        .reduce((sum, t) => sum + t.costUsd, 0);
    // The first run paid $1.50 before the restart cut it off.
    claimRun(app.db, run.id);
    noteRunProgress(app.db, run.id, { costUsd: 1.5 });
    line(run.id, 1.5, "running");
    const before = daySpent(app.db, alice.id, new Date());
    lapse(run.id);
    requeueInterrupted(app);
    // Being queued again costs nothing.
    expect(owed()).toBeCloseTo(1.5, 10);
    // The run that carries on reports only what it spent itself: $0.75.
    const next = forIssue(issue.id)[0]!;
    claimRun(app.db, next.id);
    line(next.id, 0.75, "ok");
    expect(owed()).toBeCloseTo(2.25, 10);
    expect(daySpent(app.db, alice.id, new Date()) - before).toBeCloseTo(0.75, 10);
  });
});
