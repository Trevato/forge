/**
 * The owner's limits as a verdict (#11515): a spent day or month stops a run
 * naming it; the cap is the smallest remainder; runs started together share
 * what is left; a host forge is left undecided; the mid-run stop says which
 * limit; a wake wakes only what its cause can fix; the terminal door is
 * gated like the page.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCrewBudgets } from "../src/actions/crew_budgets.ts";
import { createRepo } from "../src/actions/repos.ts";
import { addComment, openIssue } from "../src/actions/issues.ts";
import { createApp, type App } from "../src/app.ts";
import { createRun } from "../src/core/runs.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { budgetVerdict, cutOffBy, isLimitStop, NO_KEY_SAID, setBudget, stoppedBy } from "../src/crew/forge_budget.ts";
import { PARK_NOTE, parkedCount } from "../src/crew/parks.ts";
import { wakeParked } from "../src/crew/wake.ts";
import { budgetRows, setChosen } from "../src/tui/screens/crewbudgets.ts";
import { entry } from "../src/tui/screens/crewbudgets.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("the owner's limits as a verdict", () => {
  let dir = "";
  let app: App;
  let alice: User;
  let bob: User;
  let repo: Repo;
  const now = new Date();

  const spend = (usd: number, at: Date) => {
    const run = createRun(app.db, { repoId: repo.id, kind: "agent" });
    app.db
      .query(`INSERT INTO usage (run_id, repo_id, kind, cost_usd, outcome, at) VALUES (?1, ?2, 'build', ?3, 'ok', ?4)`)
      .run(run.id, repo.id, usd, at.toISOString());
  };
  const clear = () => {
    app.db.query("DELETE FROM usage").run();
    app.db.query("DELETE FROM run").run();
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-verdict-"));
    app = createApp({ dataDir: dir, port: 0 });
    const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@x.test", password: "a-long-starter-passphrase", adminIfFirst: true });
    const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "b@x.test", password: "a-long-starter-passphrase" });
    if (!a.ok || !b.ok) throw new Error("user");
    alice = a.value;
    bob = b.value;
    const r = await createRepo(app, alice, { name: "garden", visibility: "public" });
    if (!r.ok) throw new Error("repo");
    repo = r.value;
    app.db.query("UPDATE repo SET autonomy = 'autonomous' WHERE id = ?1").run(repo.id);
  });
  afterAll(async () => {
    app?.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("a forge that hosts others is left undecided", () => {
    expect(budgetVerdict(app, 5, now)).toBeUndefined();
    expect(entry.offered({ app, db: app.db, user: alice } as never)).toBe(false);
  });

  describe("on a forge of its own", () => {
    beforeAll(() => writeFileSync(join(dir, "parent.json"), "{}"));

    test("a spent day stops the run and names the day limit", () => {
      clear();
      setBudget(app.db, "run", 5, alice.id);
      setBudget(app.db, "day", 10, alice.id);
      setBudget(app.db, "month", 500, alice.id);
      spend(9.99, now);
      const v = budgetVerdict(app, 5, now);
      expect(v).toEqual({ ok: false, limit: "day", said: stoppedBy(app.db, "day") });
      expect(stoppedBy(app.db, "day")).toContain("per day limit ($10.00)");
    });

    test("a spent month stops the run and names the month limit", () => {
      clear();
      setBudget(app.db, "day", 1000, alice.id);
      setBudget(app.db, "month", 20, alice.id);
      // Yesterday's spend, in this month: the day is clear, the month is not.
      const earlier = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 1));
      spend(19.995, earlier);
      const v = budgetVerdict(app, 5, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 12)));
      expect(v?.ok).toBe(false);
      expect(v && !v.ok && v.limit).toBe("month");
      expect(v && !v.ok && v.said).toContain("per month limit ($20.00)");
    });

    test("the cap is the smallest remainder and `by` names it", () => {
      clear();
      setBudget(app.db, "run", 5, alice.id);
      setBudget(app.db, "day", 50, alice.id);
      setBudget(app.db, "month", 500, alice.id);
      expect(budgetVerdict(app, 3, now)).toEqual({ ok: true, capUsd: 3, by: undefined });
      expect(budgetVerdict(app, 20, now)).toEqual({ ok: true, capUsd: 5, by: "run" });
      spend(47, now);
      expect(budgetVerdict(app, 20, now)).toEqual({ ok: true, capUsd: 3, by: "day" });
      setBudget(app.db, "month", 48.5, alice.id);
      expect(budgetVerdict(app, 20, now)).toEqual({ ok: true, capUsd: 1.5, by: "month" });
    });

    test("runs started together share what is left, and a finished run's reservation goes", () => {
      clear();
      setBudget(app.db, "day", 8, alice.id);
      setBudget(app.db, "month", 500, alice.id);
      const first = createRun(app.db, { repoId: repo.id, kind: "agent" });
      const second = createRun(app.db, { repoId: repo.id, kind: "agent" });
      app.db.query("UPDATE run SET state = 'running' WHERE id IN (?1, ?2)").run(first.id, second.id);
      expect(budgetVerdict(app, 5, now, first.id)).toEqual({ ok: true, capUsd: 5, by: undefined });
      // The first holds $5 of the $8: the second gets $3, not $5.
      expect(budgetVerdict(app, 5, now, second.id)).toEqual({ ok: true, capUsd: 3, by: "day" });
      const third = createRun(app.db, { repoId: repo.id, kind: "agent" });
      app.db.query("UPDATE run SET state = 'running' WHERE id = ?1").run(third.id);
      expect(budgetVerdict(app, 5, now, third.id)).toEqual({ ok: false, limit: "day", said: stoppedBy(app.db, "day") });
      app.db.query("UPDATE run SET state = 'ok' WHERE id = ?1").run(first.id);
      expect(budgetVerdict(app, 5, now, third.id)).toEqual({ ok: true, capUsd: 5, by: undefined });
    });

    test("a run cut off at a cap an owner's limit set says which limit", () => {
      expect(cutOffBy(app.db, { ok: true, capUsd: 3, by: "day" }, true)).toBe(` — ${stoppedBy(app.db, "day")}`);
      expect(cutOffBy(app.db, { ok: true, capUsd: 3, by: "day" }, false)).toBe("");
      expect(cutOffBy(app.db, { ok: true, capUsd: 3, by: undefined }, true)).toBe("");
      expect(cutOffBy(app.db, undefined, true)).toBe("");
    });

    test("a wake wakes only what its cause can fix", () => {
      setBudget(app.db, "run", 0.1, alice.id);
      const park = (title: string, reason: string) => {
        const issue = openIssue(app, alice, repo, { title, body: "x" });
        if (!issue.ok) throw new Error("issue");
        addComment(app, alice, repo, issue.value, `${PARK_NOTE}${reason}`);
        return issue.value.id;
      };
      const noKey = park("needs a key", NO_KEY_SAID);
      const limited = park("needs room", stoppedBy(app.db, "run"));
      const chatter = park("mentions a key", "the tests have no key for the fixture");
      expect([noKey, limited, chatter].map((id) => parkedCount(app.db, repo, id))).toEqual([1, 1, 1]);

      expect(wakeParked(app, alice, "limit")).toBe(1);
      expect([noKey, limited, chatter].map((id) => parkedCount(app.db, repo, id))).toEqual([1, 0, 1]);
      expect(wakeParked(app, alice, "key")).toBe(1);
      expect([noKey, limited, chatter].map((id) => parkedCount(app.db, repo, id))).toEqual([0, 0, 1]);
      expect(wakeParked(app, alice, "key")).toBe(0);
      expect(isLimitStop("the per run limit stopped it")).toBe(false);
    });

    test("raising a limit through the action reports the work picked back up", () => {
      setBudget(app.db, "run", 0.1, alice.id);
      const issue = openIssue(app, alice, repo, { title: "parked by a limit", body: "x" });
      if (!issue.ok) throw new Error("issue");
      addComment(app, alice, repo, issue.value, `${PARK_NOTE}${stoppedBy(app.db, "run")}`);
      expect(saveCrewBudgets(app, alice, { run: 6 })).toEqual({ ok: true, woken: 1 });
    });

    test("the terminal door shows and sets the limits for an admin, and nothing for anyone else", () => {
      setBudget(app.db, "run", 5, alice.id);
      const as = (user: User) => ({ app, db: app.db, user }) as never;
      expect(budgetRows(as(alice), 0)[0]).toBe("> Spend per run: $5.00");
      expect(budgetRows(as(alice), 0)).toHaveLength(3);
      expect(budgetRows(as(bob), 0)).toEqual([]);
      expect(entry.offered(as(alice))).toBe(true);
      expect(entry.offered(as(bob))).toBe(false);
      expect(setChosen(as(bob), 0, "9")).toEqual({ said: "Only a forge admin sets a budget.", saved: false });
      expect(setChosen(as(alice), 0, "abc").saved).toBe(false);
      expect(setChosen(as(alice), 0, "7.50")).toEqual({ said: "Spend per run is $7.50.", saved: true });
      expect(budgetRows(as(alice), 0)[0]).toBe("> Spend per run: $7.50");
    });
  });
});
