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
    expect(WEEK).toEqual({ tolerance: 0.05, reserve: 0.1, floorSlots: 1, unknownSlots: 2, burnHours: 3 });
  });

  test("on pace: the target burn is the rest over the time left", () => {
    const d = decide({});
    expect(d.status).toBe("on pace");
    expect(d.targetPctPerHour).toBeCloseTo(50 / 84);
    expect(d.release).toBe(false);
    expect(d.slots).toBe(4);
    expect(d.sentence).toContain("On pace: 50% of the week left");
  });

  test("behind with builders idle and nothing startable releases the next gated issue", () => {
    const d = used(20, { burnPctPerHour: 0 });
    expect(d.status).toBe("behind");
    expect(d.release).toBe(true);
    expect(d.sentence).toContain("Behind pace by 30%");
  });

  test("behind does not release while work is startable, builders are busy, or nothing is gated", () => {
    const meter = meterOf({ freePct: 80, burnPctPerHour: 0 });
    expect(decide({ meter, startable: 1 }).release).toBe(false);
    expect(decide({ meter, idleSlots: 0 }).release).toBe(false);
    expect(decide({ meter, gated: 0 }).release).toBe(false);
  });

  test("ahead brings the slots down before the limit", () => {
    const d = used(70, { burnPctPerHour: 0 });
    expect(d.status).toBe("ahead");
    expect(d.slots).toBe(2);
    expect(d.release).toBe(false);
    expect(decide({ ceiling: 2, meter: meterOf({ freePct: 11, burnPctPerHour: 0 }) }).slots).toBe(1);
  });

  test("the reserve for people is a wall", () => {
    expect(used(90, { burnPctPerHour: 0 }).slots).toBe(0);
    expect(used(89, { burnPctPerHour: 0 }).slots).toBeGreaterThan(0);
  });

  test("the operator's kept share is not the crew's to spend", () => {
    expect(used(45, { keptPct: 50, burnPctPerHour: 0 }).slots).toBe(0);
  });

  test("a fast burn slows the crew even when the week's total is on pace", () => {
    const calm = used(50, { burnPctPerHour: 0.3 });
    expect(calm.slots).toBe(4);
    const fast = used(50, { burnPctPerHour: 2.7 });
    expect(fast.status).toBe("ahead");
    expect(fast.slots).toBe(1);
    expect(fast.runsOutAt).not.toBeNull();
    expect(fast.sentence).toContain("running out about");
  });

  test("today's numbers: 46% free, 2.7 points an hour, 5.3 days to the reset, slows the crew", () => {
    const now = new Date("2026-11-02T19:25:00Z");
    const d = weekDecision({
      meter: { freePct: 46, keptPct: 0, burnPctPerHour: 2.7, resetsAt: new Date("2026-11-08T02:00:00Z") },
      now,
      ceiling: 5,
      idleSlots: 0,
      startable: 0,
      gated: 0,
    })!;
    expect(d.status).toBe("ahead");
    expect(d.slots).toBeLessThan(5);
    expect(d.slots).toBeGreaterThanOrEqual(1);
    expect(d.sentence).toContain("46% of the week left");
    expect(d.sentence).toContain("running out about 2026-11-03");
    // `/talk` keeps its reserve: at the wall the crew stops, with the reserve still unspent.
    expect(d.runsOutAt!.getTime()).toBeLessThan(now.getTime() + 17 * 3_600_000);
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
