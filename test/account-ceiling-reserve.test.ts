/**
 * Runs started together cannot each pass a daily ceiling that only one of
 * them fits in (review L2): a run reserves its budget against the account's
 * day when it starts, the next run is handed only what is left, and the
 * reservation goes when the run ends.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../src/app.ts";
import type { User } from "../src/core/users.ts";
import { addToCrew } from "../src/actions/crew.ts";
import { addOwnModel, setAccountCeilings } from "../src/actions/model_grant.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { createUser } from "../src/core/users.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import { readRunLog } from "../src/runs/log.ts";
import { setLimit } from "../src/settings/limits.ts";
import { agentRunSettled, startStandInCrew, stopStandInCrew, type StandInCrew } from "./helpers/crew-standin.ts";
import { promote } from "./helpers/members.ts";

/** The budget a run's log says it was handed, in dollars. */
function handed(standIn: StandInCrew, run: Run): number {
  const line = readRunLog(standIn.dataDir, run.id).lines.find((l) => l.includes("claude: budget $"));
  const match = /claude: budget \$(\d+\.\d+)/.exec(line ?? "");
  return match === null ? 0 : Number(match[1]);
}

describe("the daily ceiling is reserved when a run starts", () => {
  let standIn: StandInCrew;
  let app: App;
  let admin: User;
  let bot: User;

  beforeAll(async () => {
    standIn = await startStandInCrew();
    ({ app, alice: admin, bot } = standIn);
    // Two runs at once, so both are in flight when the second starts.
    setLimit(app.db, "crew.concurrency", 2, admin.id);
  }, 30_000);
  afterAll(() => stopStandInCrew(standIn));

  test("two runs together are handed no more than the day's ceiling", async () => {
    const made = await createUser(app.db, { origin: "seed", trusted: true, username: "pat", email: "pat@forge.local", password: "a-good-passphrase" });
    if (!made.ok) throw new Error(made.error);
    const pat = made.value;
    promote(app.db, pat);
    const repo = await createRepo(app, pat, { name: "yard", visibility: "private" });
    if (!repo.ok) throw new Error(String(repo.error));
    const seeded = await commitToBranch(app, pat, repo.value, { message: "Start", files: [{ path: "README.md", content: "# yard\n" }] });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    expect(addToCrew(app, pat, repo.value, "bot").ok).toBe(true);
    expect(addOwnModel(app, pat, { token: "sk-ant-api03-ownkey" }).ok).toBe(true);
    // One run first, with no ceiling yet, so the crew's fork exists: two
    // first runs at once would race to make it.
    const warm = openIssue(app, pat, repo.value, { title: "Warm", body: "Soon." });
    if (!warm.ok) throw new Error(String(warm.error));
    expect(assignIssue(app, pat, repo.value, warm.value, bot).ok).toBe(true);
    await agentRunSettled(app, repo.value, (r) => r.issueId === warm.value.id, 60_000);
    // $1.50 a day, $1 a run: two runs fit only if together they take $1.50.
    expect(setAccountCeilings(app, admin, "pat", 1.5, 1).ok).toBe(true);

    const settled: Promise<Run>[] = [];
    for (const title of ["First", "Second"]) {
      const issue = openIssue(app, pat, repo.value, { title, body: "LINGER-ME until released." });
      if (!issue.ok) throw new Error(String(issue.error));
      expect(assignIssue(app, pat, repo.value, issue.value, bot).ok).toBe(true);
      settled.push(agentRunSettled(app, repo.value, (r) => r.issueId === issue.value.id, 90_000));
    }
    // Both are running before either is let finish.
    const running = () => listRuns(app.db, repo.value.id, { kind: "agent", limit: 10 }).filter((r) => r.state === "running").length;
    for (let i = 0; i < 300 && running() < 2; i++) await Bun.sleep(100);
    expect(running()).toBe(2);
    writeFileSync(join(standIn.dataDir, "release"), "");
    const runs = await Promise.all(settled);

    const budgets = runs.map((r) => handed(standIn, r)).sort();
    expect(budgets.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1.5);
    // The first is handed its per-run $1; the second only what the day has left.
    expect(budgets[1]).toBe(1);
    expect(budgets[0]).toBeGreaterThan(0);
    expect(budgets[0]).toBeLessThanOrEqual(0.5);
  }, 120_000);
});
