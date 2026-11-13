/** The week's ceiling holds an assigned run in an autonomous repository, not only the picks (#8873). */
import { readRunLog } from "../src/runs/log.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { addToCrew } from "../src/actions/crew.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { getRepoById } from "../src/core/repos.ts";
import { listRuns } from "../src/core/runs.ts";
import { noteMeasure } from "../src/core/measure.ts";
import { setHeadroom } from "../src/core/standing.ts";
import { addSubscription } from "../src/core/subscriptions.ts";
import { forgetWeek } from "../src/crew/week_read.ts";
import { startStandInCrew, stopStandInCrew, type StandInCrew } from "./helpers/crew-standin.ts";

const DAY = 86_400_000;

/** Each test's own timeout; every wait in it fits inside, with room to spare. */
const TEST_MS = 30_000;
/** One wait's deadline: a test waits at most three times, so a slow tick fails as this test, by name, before TEST_MS (#9977). */
const WAIT_MS = 8_000;

/** Wait until `done` holds, or fail at the deadline: the pump's tick is what we wait on, not a guessed pause. */
async function until(done: () => boolean, what: string, ms = WAIT_MS): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}
let standIn: StandInCrew;

beforeAll(async () => {
  standIn = await startStandInCrew({ tickMs: 50 });
}, TEST_MS);
afterAll(() => stopStandInCrew(standIn), TEST_MS);

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
  // The provider says the week is half over and 95% used.
  const now = Date.now();
  const measure = (used: number) => noteMeasure(app.db, sub.value.id, { window: "week", usedPct: used, resetsAt: new Date(now + 3.5 * DAY).toISOString(), observedAt: new Date(now).toISOString() });
  measure(95);
  const on = await updateRepoSettings(app, alice, made.value, { autonomy: "autonomous", autonomyDirection: "Ship.", autonomyCeilingUsd: 1000, autonomySlots: 4, autonomyBy: alice.id });
  expect(on.ok).toBe(true);
  const repo = getRepoById(app.db, made.value.id)!;
  const issue = openIssue(app, alice, repo, { title: "Assigned work", body: "Do it." });
  if (!issue.ok) throw new Error(String(issue.error));
  assignIssue(app, alice, repo, issue.value, bot);
  const mine = () => listRuns(app.db, repo.id, { kind: "agent", limit: 10 }).find((r) => r.issueId === issue.value.id);
  const logOf = () => (mine() === undefined ? "" : readRunLog(app.config.dataDir, mine()!.id).lines.join("\n"));
  await until(() => logOf().includes("queued, not started: 95% of the week used"), "the hold to be logged");
  expect(mine()?.state).toBe("queued");
  // With the meter back at 50% the week has room and the same run starts.
  measure(50);
  forgetWeek();
  await until(() => mine()?.state !== "queued", "the run to start");
  expect(mine()?.state).not.toBe("queued");
}, TEST_MS);
