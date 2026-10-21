/**
 * A subscription's standing in its 5-hour and weekly windows, against
 * windows worked by hand: which runs fall in, what they spent, when the
 * window opened and resets, and which of those the provider said.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createRun } from "../src/core/runs.ts";
import {
  getHeadroom,
  headroomPct,
  noteLimit,
  setHeadroom,
  standing,
  type WindowStanding,
} from "../src/core/standing.ts";
import { addSubscription, deleteSubscription } from "../src/core/subscriptions.ts";
import { recordUsage } from "../src/core/usage.ts";
import { createUser } from "../src/core/users.ts";
import { limitOf, resumeAt } from "../src/crew/limits.ts";

describe("which window the provider says is full", () => {
  test("a bare clock time is the 5-hour window, at that time exactly", () => {
    const now = new Date("2026-10-02T05:00:00Z");
    const said = "You've hit your session limit · resets 7:20am (UTC)";
    expect(limitOf(said, now)).toEqual({
      window: "5h",
      resetsAt: new Date("2026-10-02T07:20:00Z"),
    });
    // The pause still waits a minute past it.
    expect(resumeAt(said, now).toISOString()).toBe("2026-10-02T07:21:00.000Z");
  });
  test("a dated reset, or one named weekly, is the week's", () => {
    // 9pm in Chicago in September is daylight time, UTC−5: 02:00Z next day.
    expect(
      limitOf(
        "You've hit your weekly limit · resets Sep 26 at 9pm (America/Chicago)",
        new Date("2026-09-24T00:00:00Z"),
      ),
    ).toEqual({ window: "week", resetsAt: new Date("2026-09-27T02:00:00Z") });
    expect(
      limitOf("Weekly limit reached · resets 3am (UTC)", new Date("2026-10-02T05:00:00Z")),
    ).toEqual({ window: "week", resetsAt: new Date("2026-10-03T03:00:00Z") });
  });
  test("no time named is nothing read", () => {
    expect(limitOf("rate limit exceeded", new Date())).toBeUndefined();
    expect(limitOf("resets 7:20am (Not/AZone)", new Date())).toBeUndefined();
  });
});

describe("the headroom an operator keeps", () => {
  test("is a whole percent 0–90", () => {
    expect(headroomPct("0")).toBe(0);
    expect(headroomPct("20")).toBe(20);
    expect(headroomPct(" 90 ")).toBe(90);
    for (const bad of ["91", "-1", "12.5", "", "1e1", "100", "abc"])
      expect(headroomPct(bad)).toBeUndefined();
  });
});

describe("a subscription's standing", () => {
  let dataDir: string;
  let app: App;
  let repo: Repo;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-standing-"));
    app = createApp({ dataDir, port: 0 });
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    // A bare row: runs only need a repo id, and git init (a child process)
    // and argon2 hashing made this hook's verdict depend on the check
    // machine's load. Nothing here clones or signs in.
    const repoId = "standing-repo";
    app.db
      .query("INSERT INTO repo (id, owner_id, name, visibility, description, default_branch) VALUES (?1, ?2, 'one', 'private', '', 'main')")
      .run(repoId, a.value.id);
    repo = getRepoById(app.db, repoId)!;
  }, 60_000);
  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  let n = 0;
  const account = (): string => {
    const added = addSubscription(app.db, dataDir, {
      name: `account ${++n}`,
      token: `sk-ant-oat01-standing-test-${n}`,
    });
    if (!added.ok) throw new Error(added.error);
    return added.value.id;
  };
  /** A run on `sub` that started at `start`, ran `minutes`, spent `usd`. */
  const spend = (sub: string, start: string, minutes: number, usd: number): void => {
    const wallMs = minutes * 60_000;
    recordUsage(app.db, {
      runId: createRun(app.db, { repoId: repo.id, kind: "agent" }).id,
      repoId: repo.id,
      issueId: null,
      agentId: null,
      subscriptionId: sub,
      tokensIn: 1000,
      tokensOut: 100,
      costUsd: usd,
      wallMs,
      outcome: "ok",
      at: new Date(Date.parse(start) + wallMs).toISOString(),
    });
  };
  const win = (sub: string, now: string, w: "5h" | "week"): WindowStanding =>
    standing(app.db, sub, new Date(now))!.windows.find((x) => x.window === w)!;

  test("with nothing said, each window opens at the first run after the last closed", () => {
    const sub = account();
    spend(sub, "2026-10-02T03:00:00Z", 10, 4); // opens 03:00–08:00
    spend(sub, "2026-10-02T08:00:00Z", 30, 1.25); // at 08:00 that one has closed: opens 08:00–13:00
    spend(sub, "2026-10-02T10:00:00Z", 10, 0.5); // inside 08:00–13:00
    const now = "2026-10-02T12:00:00Z";

    // 5 h: 08:00–13:00 holds 1.25 + 0.5 = 1.75. No refusal yet, so no cap.
    const session = win(sub, now, "5h");
    expect(session.startsAt).toEqual({ value: "2026-10-02T08:00:00.000Z", source: "inferred" });
    expect(session.resetsAt).toEqual({ value: "2026-10-02T13:00:00.000Z", source: "inferred" });
    expect(session.used).toEqual({ value: 1.75, source: "inferred" });
    expect(session.runs).toBe(2);
    expect(session.tokensIn).toBe(2000);
    expect(session.cap).toBeNull();
    expect(session.remaining).toBeNull();
    expect(session.crewRemaining).toBeNull();

    // The week opened with the 03:00 run and holds all three: 5.75.
    const week = win(sub, now, "week");
    expect(week.startsAt).toEqual({ value: "2026-10-02T03:00:00.000Z", source: "inferred" });
    expect(week.resetsAt).toEqual({ value: "2026-10-09T03:00:00.000Z", source: "inferred" });
    expect(week.used.value).toBe(5.75);

    // At 13:00 the 5-hour window has closed and nothing has opened another.
    const later = win(sub, "2026-10-02T13:00:00Z", "5h");
    expect(later.startsAt).toBeNull();
    expect(later.resetsAt).toBeNull();
    expect(later.used).toEqual({ value: 0, source: "inferred" });
  });

  test("the provider's refusal is read: full until its reset, and the ledger then gives the cap", () => {
    const sub = account();
    expect(setHeadroom(app.db, sub, 20)).toBe(true);
    spend(sub, "2026-10-02T08:00:00Z", 30, 2); // before the window the provider names
    spend(sub, "2026-10-02T09:30:00Z", 30, 3);
    spend(sub, "2026-10-02T10:30:00Z", 20, 2); // the run that was refused at 11:00
    noteLimit(app.db, sub, {
      window: "5h",
      resetsAt: "2026-10-02T14:00:00.000Z",
      observedAt: "2026-10-02T11:00:00.000Z",
      said: "You've hit your session limit · resets 2pm (UTC)",
    });

    // At 12:00: the window is 09:00–14:00 on the provider's word. In it
    // the crew had spent 3 + 2 = 5 when it was refused: the cap. Remaining
    // is 0, read; 20% of 5 = 1 is kept for people.
    const full = win(sub, "2026-10-02T12:00:00Z", "5h");
    expect(full.startsAt).toEqual({ value: "2026-10-02T09:00:00.000Z", source: "read" });
    expect(full.resetsAt).toEqual({ value: "2026-10-02T14:00:00.000Z", source: "read" });
    expect(full.used).toEqual({ value: 5, source: "inferred" });
    expect(full.cap).toEqual({ value: 5, source: "inferred" });
    expect(full.remaining).toEqual({ value: 0, source: "read" });
    expect(full.kept).toEqual({ value: 1, source: "inferred" });
    expect(full.crewRemaining).toEqual({ value: 0, source: "read" });
    expect(full.said).toContain("session limit");

    // At 15:00 the reset has passed and nothing has run since: no window
    // open, the cap still known, everything but the 20% the crew's.
    const after = win(sub, "2026-10-02T15:00:00Z", "5h");
    expect(after.startsAt).toBeNull();
    expect(after.cap).toEqual({ value: 5, source: "inferred" });
    expect(after.remaining).toEqual({ value: 5, source: "inferred" });
    expect(after.crewRemaining).toEqual({ value: 4, source: "inferred" });

    // A run at 14:30 for $1.20 opens the next window, 14:30–19:30:
    // remaining 5 − 1.2 = 3.8, the crew's 3.8 − 1 = 2.8.
    spend(sub, "2026-10-02T14:30:00Z", 10, 1.2);
    const next = win(sub, "2026-10-02T15:00:00Z", "5h");
    expect(next.startsAt).toEqual({ value: "2026-10-02T14:30:00.000Z", source: "inferred" });
    expect(next.resetsAt).toEqual({ value: "2026-10-02T19:30:00.000Z", source: "inferred" });
    expect(next.used.value).toBe(1.2);
    expect(next.remaining).toEqual({ value: 3.8, source: "inferred" });
    expect(next.crewRemaining).toEqual({ value: 2.8, source: "inferred" });
  });

  test("a weekly reset once read repeats every seven days", () => {
    const sub = account();
    spend(sub, "2026-09-25T10:00:00Z", 60, 30); // in the week the provider closed
    spend(sub, "2026-09-29T10:00:00Z", 60, 6); // in the week after
    spend(sub, "2026-10-02T09:00:00Z", 60, 4.5);
    noteLimit(app.db, sub, {
      window: "week",
      resetsAt: "2026-09-28T02:00:00.000Z",
      observedAt: "2026-09-27T20:00:00.000Z",
      said: "You've hit your weekly limit · resets Sep 27 at 9pm (America/Chicago)",
    });
    // Sep 28 02:00 + 7 d = Oct 5 02:00, the first reset after Oct 2 12:00.
    // Used since Sep 28 02:00: 6 + 4.5. The cap is the week to Sep 27 20:00: 30.
    const week = win(sub, "2026-10-02T12:00:00Z", "week");
    expect(week.startsAt).toEqual({ value: "2026-09-28T02:00:00.000Z", source: "inferred" });
    expect(week.resetsAt).toEqual({ value: "2026-10-05T02:00:00.000Z", source: "inferred" });
    expect(week.used.value).toBe(10.5);
    expect(week.cap).toEqual({ value: 30, source: "inferred" });
    expect(week.remaining).toEqual({ value: 19.5, source: "inferred" });
    // Exactly at a projected reset, the next week begins.
    const edge = win(sub, "2026-10-05T02:00:00Z", "week");
    expect(edge.startsAt!.value).toBe("2026-10-05T02:00:00.000Z");
    expect(edge.used.value).toBe(0);
  });

  test("the newest word for a window replaces the last; a removed account has none", () => {
    const sub = account();
    const said = (resetsAt: string) =>
      noteLimit(app.db, sub, {
        window: "5h",
        resetsAt,
        observedAt: "2026-10-02T11:00:00.000Z",
        said: "x".repeat(500),
      });
    said("2026-10-02T13:00:00.000Z");
    said("2026-10-02T14:00:00.000Z");
    const w = win(sub, "2026-10-02T12:00:00Z", "5h");
    expect(w.resetsAt!.value).toBe("2026-10-02T14:00:00.000Z");
    expect(w.said!.length).toBe(160);
    expect(setHeadroom(app.db, sub, 91)).toBe(false);
    expect(setHeadroom(app.db, sub, -1)).toBe(false);
    expect(getHeadroom(app.db, sub)).toBe(0);
    expect(deleteSubscription(app.db, sub)).toBe(true);
    expect(standing(app.db, sub, new Date())).toBeUndefined();
    expect(setHeadroom(app.db, sub, 10)).toBe(false);
    // A note for an account that is not there is dropped, not kept.
    said("2026-10-02T15:00:00.000Z");
    expect(
      app.db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM subscription_limit WHERE subscription_id = ?1",
        )
        .get(sub)!.n,
    ).toBe(0);
  });
});
