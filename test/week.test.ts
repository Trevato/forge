/** The week's ceiling, and the efficiency leaves out pulls that added nothing (#8695). */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { id } from "../src/kernel/id.ts";
import { efficiencySince } from "../src/crew/week_read.ts";
import { efficiencyWords, weekDecision, type WeekInput } from "../src/crew/week.ts";

const DAY = 86_400_000;
const NOW = new Date("2026-11-02T12:00:00Z");
// Halfway through the week: 3.5 days to the reset, half of it free.
const base: WeekInput = {
  meter: { freePct: 50, keptPct: 0, resetsAt: new Date(NOW.getTime() + 3.5 * DAY) },
  now: NOW,
  ceiling: 4,
  reserve: 0.1,
};
const meterOf = (over: Partial<NonNullable<WeekInput["meter"]>>) => ({ ...base.meter!, ...over });
const decide = (over: Partial<WeekInput>) => weekDecision({ ...base, ...over })!;
const used = (usedPct: number, over: Partial<NonNullable<WeekInput["meter"]>> = {}) =>
  decide({ meter: meterOf({ freePct: 100 - usedPct, ...over }) });

describe("weekDecision", () => {
  test("at the ceiling's share the crew waits; below it nothing slows it, whatever the burn", () => {
    expect(used(10).slots).toBe(4);
    expect(used(99, { keptPct: 0 }).slots).toBe(0);
    // The weekly budget is the share the crew may use: 90% leaves a reserve of 10%.
    expect(decide({ meter: meterOf({ freePct: 15 }), reserve: 0.1 }).slots).toBe(4);
    expect(decide({ meter: meterOf({ freePct: 10 }), reserve: 0.1 }).slots).toBe(0);
  });

  test("at a budget of 100% the crew runs until the provider refuses", () => {
    expect(decide({ meter: meterOf({ freePct: 1 }), reserve: 0 }).slots).toBe(4);
  });

  test("the operator's kept share is not the crew's to spend", () => {
    expect(decide({ meter: meterOf({ freePct: 20, keptPct: 20 }), reserve: 0 }).slots).toBe(0);
  });

  test("the sentence says what is used and what the crew may use", () => {
    expect(used(25).sentence).toBe("25% of the week used, the crew may use up to 90%.");
    expect(used(95).sentence).toContain("it waits for the reset 2026-11-06 00:00 UTC");
  });

  test("an unmeasured or ended week is no decision", () => {
    expect(weekDecision({ ...base, meter: null })).toBeNull();
    expect(weekDecision({ ...base, now: new Date(NOW.getTime() + 4 * DAY) })).toBeNull();
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
