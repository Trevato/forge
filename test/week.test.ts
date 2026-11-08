/** The week's pace: the same state gives the same decision, and the efficiency leaves out pulls that added nothing (#8695). */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { id } from "../src/kernel/id.ts";
import { efficiencySince } from "../src/crew/week_read.ts";
import { efficiencyWords, WEEK, weekDecision, type WeekInput } from "../src/crew/week.ts";

const DAY = 86_400_000;
const NOW = new Date("2026-11-02T12:00:00Z");
// Halfway through the week: 3.5 days to the reset, half of it free.
const base: WeekInput = {
  meter: { freePct: 50, keptPct: 0, burnPctPerHour: 0.4, resetsAt: new Date(NOW.getTime() + 3.5 * DAY) },
  now: NOW,
  ceiling: 4,
  floorSlots: 2,
  idleSlots: 2,
  startable: 0,
  gated: 3,
};
const meterOf = (over: Partial<NonNullable<WeekInput["meter"]>>) => ({ ...base.meter!, ...over });
const decide = (over: Partial<WeekInput>) => weekDecision({ ...base, ...over })!;
const used = (usedPct: number, over: Partial<NonNullable<WeekInput["meter"]>> = {}) =>
  decide({ meter: meterOf({ freePct: 100 - usedPct, ...over }) });

describe("weekDecision", () => {
  test("the same state gives the same decision", () => {
    expect(weekDecision(base)).toEqual(weekDecision({ ...base }));
  });

  test("settings are plain values", () => {
    expect(WEEK).toEqual({ tolerance: 0.25, reserve: 0.1, unknownSlots: 2, burnHours: 1 });
  });

  test("on pace: a burn near allowed keeps the ceiling", () => {
    // 50% used, 84 hours left, 10% reserve: 40 / 84 = 0.476 an hour allowed.
    const d = decide({ meter: meterOf({ burnPctPerHour: 0.45 }) });
    expect(d.status).toBe("on pace");
    expect(d.targetPctPerHour).toBeCloseTo(50 / 84);
    expect(d.allowedPctPerHour).toBeCloseTo(40 / 84);
    expect(d.release).toBe(false);
    expect(d.slots).toBe(4);
    expect(d.sentence).toContain("On pace: 50% of the week left");
  });

  test("burning under allowed with builders idle and nothing startable releases the next gated issue", () => {
    const d = used(20, { burnPctPerHour: 0 });
    expect(d.status).toBe("behind");
    expect(d.release).toBe(true);
    expect(d.slots).toBe(4);
    expect(d.sentence).toContain("releasing the next issue");
  });

  test("what was spent is sunk: a heavy week so far does not slow a crew that burns under allowed", () => {
    const d = used(70, { burnPctPerHour: 0 });
    expect(d.status).toBe("behind");
    expect(d.slots).toBe(4);
  });

  test("under allowed does not release while work is startable, builders are busy, or nothing is gated", () => {
    const meter = meterOf({ freePct: 80, burnPctPerHour: 0 });
    expect(decide({ meter, startable: 1 }).release).toBe(false);
    expect(decide({ meter, idleSlots: 0 }).release).toBe(false);
    expect(decide({ meter, gated: 0 }).release).toBe(false);
  });

  test("the reserve for people is a wall", () => {
    expect(used(90, { burnPctPerHour: 0 }).slots).toBe(0);
    expect(used(89, { burnPctPerHour: 0 }).slots).toBeGreaterThan(0);
  });

  test("the operator's kept share is not the crew's to spend", () => {
    expect(used(45, { keptPct: 50, burnPctPerHour: 0 }).slots).toBe(0);
  });

  test("a fast burn slows the crew", () => {
    const fast = used(50, { burnPctPerHour: 2.7 });
    expect(fast.status).toBe("ahead");
    expect(fast.slots).toBe(2);
    expect(fast.runsOutAt).not.toBeNull();
    expect(fast.sentence).toContain("running out about");
  });

  test("2026-11-02: 2.7 points an hour slows hard, then flat at 45% free speeds up and releases", () => {
    const resetsAt = new Date("2026-11-08T02:00:00Z");
    const at = (iso: string, freePct: number, burnPctPerHour: number) =>
      weekDecision({
        meter: { freePct, keptPct: 0, burnPctPerHour, resetsAt },
        now: new Date(iso),
        ceiling: 5,
        floorSlots: 2,
        idleSlots: 3,
        startable: 0,
        gated: 2,
      })!;
    const hot = at("2026-11-02T19:25:00Z", 46, 2.7);
    expect(hot.status).toBe("ahead");
    expect(hot.slots).toBe(2);
    expect(hot.release).toBe(false);
    expect(hot.sentence).toContain("running out about 2026-11-03");
    const flat = at("2026-11-02T20:45:00Z", 45, 0);
    expect(flat.status).toBe("behind");
    expect(flat.slots).toBe(5);
    expect(flat.release).toBe(true);
  });

  test("with no burn known yet the crew starts modest", () => {
    const d = used(50, { burnPctPerHour: null });
    expect(d.slots).toBe(WEEK.unknownSlots);
    expect(d.release).toBe(false);
    expect(d.sentence).toContain("too few readings");
  });

  test("unknown capacity is not fine: the crew holds at a modest level and home says so", () => {
    const d = decide({ meter: null });
    expect(d.status).toBe("unknown");
    expect(d.slots).toBe(WEEK.unknownSlots);
    expect(d.sentence).toContain("pace is unknown");
    expect(decide({ meter: null, ceiling: 1 }).slots).toBe(1);
  });

  test("an ended week is no decision", () => {
    expect(weekDecision({ ...base, meter: meterOf({ resetsAt: NOW }) })).toBeNull();
  });
});

describe("efficiency", () => {
  test("pulls closed as already on the base are not landings", async () => {
    const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "forge-week-")), port: 0 });
    const u = await createUser(app.db, { username: "alice", email: "a@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true, adminIfFirst: true });
    if (!u.ok) throw new Error(u.error);
    const made = await createRepo(app.db, app.reposRoot, { ownerId: u.value.id, name: "r", visibility: "public", description: "r" });
    if (!made.ok) throw new Error(made.error);
    const repo = made.value;
    const at = NOW.toISOString();
    let n = 0;
    const pull = (carried: number, mergedOid: string) => {
      const issueId = id();
      n++;
      app.db.query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, ?3, 'pull', 'P', '', ?4, 'open', ?5)`).run(issueId, repo.id, n, u.value.id, at);
      app.db.query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id, merged_at, merged_oid, carried) VALUES (?1, ?2, ?3, 'base', '', ?4, ?5, ?6, ?7)`).run(issueId, repo.defaultBranch, `b/${n}`, repo.id, at, mergedOid, carried);
    };
    pull(0, "new1");
    pull(0, "new2");
    pull(1, "old");
    pull(0, "base");
    for (const cost of [1, 2, 3, 4, 5, 6])
      app.db.query(`INSERT INTO run (id, repo_id, kind, state, cost_usd, created_at) VALUES (?1, ?2, 'agent', 'ok', ?3, ?4)`).run(id(), repo.id, cost, at);
    const e = efficiencySince(app, repo, new Date(NOW.getTime() - DAY));
    expect(e).toEqual({ landings: 2, runs: 6, costUsd: 21 });
    expect(efficiencyWords(e)).toContain("$10.50 and 3 runs");
    expect(efficiencyWords({ landings: 0, runs: 2, costUsd: 4 })).toContain("Nothing has landed");
  });
});
