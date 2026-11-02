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
// Halfway through the week: 3.5 days to the reset.
const base: WeekInput = {
  capUsd: 100,
  usedUsd: 50,
  resetsAt: new Date(NOW.getTime() + 3.5 * DAY),
  now: NOW,
  ceiling: 4,
  idleSlots: 2,
  startable: 0,
  gated: 3,
};
const decide = (over: Partial<WeekInput>) => weekDecision({ ...base, ...over })!;

describe("weekDecision", () => {
  test("the same state gives the same decision", () => {
    expect(weekDecision(base)).toEqual(weekDecision({ ...base }));
  });

  test("settings are plain values", () => {
    expect(WEEK).toEqual({ tolerance: 0.05, reserve: 0.1, floorSlots: 1 });
  });

  test("on pace: the target burn is the rest over the time left", () => {
    const d = decide({});
    expect(d.status).toBe("on pace");
    expect(d.targetUsdPerDay).toBeCloseTo(50 / 3.5);
    expect(d.release).toBe(false);
    expect(d.slots).toBe(4);
    expect(d.sentence).toContain("On pace");
  });

  test("behind with builders idle and nothing startable releases the next gated issue", () => {
    const d = decide({ usedUsd: 20 });
    expect(d.status).toBe("behind");
    expect(d.release).toBe(true);
    expect(d.sentence).toContain("Behind pace by $30.00");
  });

  test("behind does not release while work is startable, builders are busy, or nothing is gated", () => {
    expect(decide({ usedUsd: 20, startable: 1 }).release).toBe(false);
    expect(decide({ usedUsd: 20, idleSlots: 0 }).release).toBe(false);
    expect(decide({ usedUsd: 20, gated: 0 }).release).toBe(false);
  });

  test("ahead brings the slots down before the limit", () => {
    const d = decide({ usedUsd: 70 });
    expect(d.status).toBe("ahead");
    expect(d.slots).toBe(2);
    expect(d.release).toBe(false);
    expect(decide({ usedUsd: 89, ceiling: 2 }).slots).toBe(1);
  });

  test("the reserve for people is a wall", () => {
    expect(decide({ usedUsd: 90 }).slots).toBe(0);
    expect(decide({ usedUsd: 89 }).slots).toBeGreaterThan(0);
  });

  test("no known capacity or an ended week is no decision", () => {
    expect(weekDecision({ ...base, capUsd: 0 })).toBeNull();
    expect(weekDecision({ ...base, resetsAt: NOW })).toBeNull();
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
