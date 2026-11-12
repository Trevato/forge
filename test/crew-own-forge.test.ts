/**
 * A forge that is its owner's own (#11515): with no key the crew stops with
 * the add-a-key words and parks the issue; adding a key, or raising a limit,
 * picks the issue back up once; the host is never asked for model access.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { saveCrewBudgets } from "../src/actions/crew_budgets.ts";
import { saveCrewKey } from "../src/actions/crew_key.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { updateRepoSettings } from "../src/actions/repos.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import { PLATFORM } from "../src/core/subscriptions.ts";
import { budgetLimit, setBudget } from "../src/crew/forge_budget.ts";
import { parkedCount } from "../src/crew/parks.ts";
import { wokeWords } from "../src/crew/wake.ts";
import { readRunLog } from "../src/runs/log.ts";
import { promote } from "./helpers/members.ts";
import { agentRunSettled, startStandInCrew, stopStandInCrew, type StandInCrew } from "./helpers/crew-standin.ts";

describe("a forge of its own: its key, its limits, and the work picked back up", () => {
  let standIn: StandInCrew;
  let app: App;
  let alice: User;
  let bot: User;
  let repo: Repo;

  beforeAll(async () => {
    standIn = await startStandInCrew();
    ({ app, alice, bot, repo } = standIn);
    // A hosted child: its host's file is in the data directory. No host grant, no key, no env.
    writeFileSync(join(standIn.dataDir, "parent.json"), "{}");
    delete process.env.ANTHROPIC_API_KEY;
    const on = await updateRepoSettings(app, alice, repo, {
      autonomy: "autonomous",
      autonomyDirection: "Keep the garden small.",
      autonomyCeilingUsd: 100,
      autonomyBy: alice.id,
    });
    expect(on.ok).toBe(true);
    // Not an admin of the forge until the key is added: the grant path has nothing for it.
    app.db.query("UPDATE user SET is_admin = 0 WHERE id = ?1").run(alice.id);
    promote(app.db, alice);
  }, 30_000);
  afterAll(() => stopStandInCrew(standIn));

  const runsOf = (issueId: string): Run[] => listRuns(app.db, repo.id, { kind: "agent", limit: 50 }).filter((r) => r.issueId === issueId);

  async function settledNth(issueId: string, n: number): Promise<Run> {
    for (let i = 0; i < 700; i++) {
      const done = runsOf(issueId).filter((r) => r.state === "ok" || r.state === "failed");
      if (done.length >= n) return done.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[n - 1]!;
      await Bun.sleep(100);
    }
    throw new Error(`run ${n} did not settle`);
  }

  test("no key: the run stops with the add-a-key words and the issue is parked; a key picks it back up", async () => {
    const issue = openIssue(app, alice, repo, { title: "Prune the roses", body: "Before spring." });
    if (!issue.ok) throw new Error(String(issue.error));
    expect(assignIssue(app, alice, repo, issue.value, bot).ok).toBe(true);
    const first = await agentRunSettled(app, repo, (r) => r.issueId === issue.value.id, 60_000);
    expect(first.state).toBe("failed");
    expect(first.summary).toContain("This forge has no model key");
    expect(first.summary).not.toContain("ask an admin");
    expect(existsSync(standIn.argsFile)).toBe(false);
    for (let i = 0; i < 100 && parkedCount(app.db, repo, issue.value.id) === 0; i++) await Bun.sleep(100);
    expect(parkedCount(app.db, repo, issue.value.id)).toBe(1);

    app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(alice.id);
    const admin = { ...alice, isAdmin: true };
    const saved = await saveCrewKey(app, admin, "sk-ant-api03-ownerskey");
    expect(saved).toEqual({ ok: true, woken: 1 });
    expect(wokeWords(1)).toBe("1 issue picked back up.");
    expect(parkedCount(app.db, repo, issue.value.id)).toBe(0);

    // Within a minute a second run starts, on the owner's key and never the host's.
    const second = await settledNth(issue.value.id, 2);
    expect(existsSync(standIn.argsFile)).toBe(true);
    const log = readRunLog(standIn.dataDir, second.id).lines.join("\n");
    expect(log).toContain("subscription: my-key");
    expect(log).not.toContain("platform");
    // The forge's spend never appears against the host's credit.
    const hostRows = app.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM usage WHERE subscription_id = ?1").get(PLATFORM);
    expect(hostRows?.n).toBe(0);
    expect(existsSync(join(standIn.dataDir, "funding.json"))).toBe(false);
  }, 120_000);

  test("a per-run limit of $0.10 stops a run naming it; raising it runs the issue again", async () => {
    rmSync(standIn.argsFile, { force: true });
    const admin = { ...alice, isAdmin: true };
    expect(saveCrewBudgets(app, admin, { run: 0.1 })).toEqual({ ok: true, woken: 0 });
    expect(budgetLimit(app.db, "run")).toBe(0.1);
    const issue = openIssue(app, alice, repo, { title: "Mow the lawn", body: "Soon." });
    if (!issue.ok) throw new Error(String(issue.error));
    expect(assignIssue(app, alice, repo, issue.value, bot).ok).toBe(true);
    const stopped = await agentRunSettled(app, repo, (r) => r.issueId === issue.value.id, 60_000);
    expect(stopped.state).toBe("failed");
    expect(stopped.summary).toContain("per run limit ($0.10)");
    expect(stopped.summary).toContain("/settings/crew#budgets");
    expect(existsSync(standIn.argsFile)).toBe(false);
    for (let i = 0; i < 100 && parkedCount(app.db, repo, issue.value.id) === 0; i++) await Bun.sleep(100);

    expect(saveCrewBudgets(app, admin, { run: 5 })).toEqual({ ok: true, woken: 1 });
    const again = await settledNth(issue.value.id, 2);
    expect(again.summary).not.toContain("limit");
    expect(existsSync(standIn.argsFile)).toBe(true);
  }, 120_000);

  test("the limits refuse what is not dollars and cents, and only an admin sets them (a spent day or month: forge-budget-verdict.test.ts)", () => {
    const admin = { ...alice, isAdmin: true };
    expect(saveCrewBudgets(app, admin, { day: -1 })).toEqual({ ok: false, error: "invalid_amount" });
    expect(saveCrewBudgets(app, admin, { month: 1.234 })).toEqual({ ok: false, error: "invalid_amount" });
    expect(saveCrewBudgets(app, { ...alice, isAdmin: false }, { day: 5 })).toEqual({ ok: false, error: "not_found" });
    expect(setBudget(app.db, "day", 0.01, alice.id)).toBe(true);
    expect(budgetLimit(app.db, "day")).toBe(0.01);
  });
});
