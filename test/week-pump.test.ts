/** The week's pace holds an assigned run in an autonomous repository, not only the picks (#8873). */
import { readRunLog } from "../src/runs/log.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { addToCrew } from "../src/actions/crew.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { getRepoById } from "../src/core/repos.ts";
import { createRun, listRuns } from "../src/core/runs.ts";
import { noteLimit, setHeadroom } from "../src/core/standing.ts";
import { addSubscription } from "../src/core/subscriptions.ts";
import { forgetWeek } from "../src/crew/week_read.ts";
import { recordUsage } from "../src/core/usage.ts";
import { startStandInCrew, stopStandInCrew, type StandInCrew } from "./helpers/crew-standin.ts";

const DAY = 86_400_000;

/** Wait until `done` holds, or fail at the deadline: the pump's tick is what we wait on, not a guessed pause. */
async function until(done: () => boolean, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}
let standIn: StandInCrew;

beforeAll(async () => {
  standIn = await startStandInCrew({ tickMs: 50 });
}, 30_000);
afterAll(() => stopStandInCrew(standIn));

test("past the week's reserve an assigned run stays queued, with the reason in its log", async () => {
  const { app, alice, bot } = standIn;
  const made = await createRepo(app, alice, { name: "held", visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  const seeded = await commitToBranch(app, alice, made.value, { message: "Start", files: [{ path: "README.md", content: "# held\n" }] });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  expect(addToCrew(app, alice, made.value, "bot").ok).toBe(true);
  const sub = addSubscription(app.db, standIn.dataDir, { name: "main", token: "sk-ant-oat01-week-pump-1" });
  if (!sub.ok) throw new Error(sub.error);
  setHeadroom(app.db, sub.value.id, 0);
  app.db.query("INSERT INTO subscription_grant (scope_id, agent_id, subscription_id) VALUES (?1, '', ?2)").run(made.value.id, sub.value.id);
  // Last week the provider refused at $100; this week $95 is spent.
  const now = Date.now();
  const spend = (usd: number, at: number) => {
    const run = createRun(app.db, { repoId: made.value.id, kind: "agent" });
    recordUsage(app.db, { runId: run.id, repoId: made.value.id, issueId: null, agentId: null, subscriptionId: sub.value.id, tokensIn: 1, tokensOut: 1, costUsd: usd, wallMs: 1000, outcome: "ok", at: new Date(at).toISOString() });
  };
  spend(100, now - 4 * DAY);
  noteLimit(app.db, sub.value.id, { window: "week", resetsAt: new Date(now - 3.5 * DAY).toISOString(), observedAt: new Date(now - 3.5 * DAY - 3_600_000).toISOString(), said: "weekly limit" });
  spend(95, now - DAY);
  const on = await updateRepoSettings(app, alice, made.value, { autonomy: "autonomous", autonomyDirection: "Ship.", autonomyCeilingUsd: 1000, autonomySlots: 4, autonomyBy: alice.id });
  expect(on.ok).toBe(true);
  const repo = getRepoById(app.db, made.value.id)!;
  const issue = openIssue(app, alice, repo, { title: "Assigned work", body: "Do it." });
  if (!issue.ok) throw new Error(String(issue.error));
  assignIssue(app, alice, repo, issue.value, bot);
  const mine = () => listRuns(app.db, repo.id, { kind: "agent", limit: 10 }).find((r) => r.issueId === issue.value.id);
  const logOf = () => (mine() === undefined ? "" : readRunLog(app.config.dataDir, mine()!.id).lines.join("\n"));
  await until(() => logOf().includes("queued, not started: Ahead of pace"), "the hold to be logged");
  expect(mine()?.state).toBe("queued");
  // With the spend gone the week is on pace and the same run starts.
  app.db.query("DELETE FROM usage WHERE at >= ?1").run(new Date(now - 2 * DAY).toISOString());
  forgetWeek();
  await until(() => mine()?.state !== "queued", "the run to start");
  expect(mine()?.state).not.toBe("queued");
}, 30_000);
