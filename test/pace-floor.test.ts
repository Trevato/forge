/**
 * Through the pump: at the pacer's slowest a review and work a person
 * assigned still start within the floor, the crew's own pick waits with the
 * pace sentence, and at the reserve's wall everything waits (#8962).
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { addToCrew } from "../src/actions/crew.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { paceFloor, setCapacity } from "../src/core/capacity.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun, getRun, listActive } from "../src/core/runs.ts";
import { noteMeasure } from "../src/core/measure.ts";
import { setHeadroom } from "../src/core/standing.ts";
import { addSubscription } from "../src/core/subscriptions.ts";
import { forgetWeek } from "../src/crew/week_read.ts";
import { readRunLog } from "../src/runs/log.ts";
import { startStandInCrew, stopStandInCrew, type StandInCrew } from "./helpers/crew-standin.ts";

const DAY = 86_400_000;
let standIn: StandInCrew;

beforeAll(async () => {
  standIn = await startStandInCrew({ tickMs: 50 });
  setCapacity(standIn.app.db, "crew.concurrency", "10", standIn.alice.id);
}, 30_000);
afterAll(() => stopStandInCrew(standIn));

async function until(done: () => boolean, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** An autonomous repository whose week has `spentUsd` of $100 gone and burns 6 points an hour. */
async function pacedRepo(name: string, spentUsd: number): Promise<Repo> {
  const { app, alice, dataDir } = standIn;
  const made = await createRepo(app, alice, { name, visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  const seeded = await commitToBranch(app, alice, made.value, { message: "Start", files: [{ path: "README.md", content: `# ${name}\n` }] });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  expect(addToCrew(app, alice, made.value, "bot").ok).toBe(true);
  const sub = addSubscription(app.db, dataDir, { name, token: `sk-ant-oat01-pace-floor-${name}` });
  if (!sub.ok) throw new Error(sub.error);
  setHeadroom(app.db, sub.value.id, 0);
  app.db.query("INSERT INTO subscription_grant (scope_id, agent_id, subscription_id) VALUES (?1, '', ?2)").run(made.value.id, sub.value.id);
  const now = Date.now();
  // The provider's meter: `spentUsd` percent of the week used, with half the week's time gone.
  noteMeasure(app.db, sub.value.id, { window: "week", usedPct: spentUsd, resetsAt: new Date(now + 3.5 * DAY).toISOString(), observedAt: new Date(now).toISOString() });
  app.db.query("INSERT INTO week_reading (scope, at, free_pct) VALUES (?1, ?2, ?3)").run(sub.value.id, new Date(now - 3_600_000).toISOString(), 100 - spentUsd + 6);
  const on = await updateRepoSettings(app, alice, made.value, { autonomy: "autonomous", autonomyDirection: "Ship.", autonomyCeilingUsd: 1000, autonomySlots: 4, autonomyBy: alice.id });
  expect(on.ok).toBe(true);
  forgetWeek();
  return getRepoById(app.db, made.value.id)!;
}

const logOf = (id: string) => readRunLog(standIn.app.config.dataDir, id).lines.join("\n");
const stateOf = (id: string) => getRun(standIn.app.db, id)!.state;

/** A run queued by assigning a fresh issue to the agent; `pick` marks it the crew's own. */
function assigned(repo: Repo, title: string, pick: boolean): string {
  const { app, alice, bot } = standIn;
  const issue = openIssue(app, alice, repo, { title, body: "Do it." });
  if (!issue.ok) throw new Error(String(issue.error));
  assignIssue(app, alice, repo, issue.value, bot, undefined, pick);
  const run = listActive(app.db, "agent").find((r) => r.issueId === issue.value.id);
  if (run === undefined) throw new Error("no run queued");
  return run.id;
}

test("the floor is a config value, 2 by default", () => {
  expect(paceFloor(standIn.app.db)).toBe(2);
});

test("at the slowest pace a review and a person's assignment start, a pick waits with the pace sentence", async () => {
  const { app } = standIn;
  // 30% free, 36% an hour ago: far over what is allowed, so the pace is down to the floor of 2 slots.
  const repo = await pacedRepo("floor", 70);
  // Two builds fill the pace's slots.
  for (let i = 0; i < 2; i++) {
    const issue = openIssue(app, standIn.alice, repo, { title: `build ${i}`, body: "x" });
    if (!issue.ok) throw new Error(String(issue.error));
    claimRun(app.db, createRun(app.db, { repoId: repo.id, kind: "agent", issueId: issue.value.id, reason: "push", actorId: standIn.bot.id }).id);
  }
  const pick = assigned(repo, "The crew's pick", true);
  await until(() => logOf(pick).includes("queued, not started: Ahead of pace"), "the pick to be held");
  const person = assigned(repo, "A person's issue", false);
  const review = createRun(app.db, { repoId: repo.id, kind: "agent", reason: "review", actorId: standIn.bot.id }).id;
  await until(() => stateOf(person) !== "queued" && stateOf(review) !== "queued", "the person's run and the review to start");
  expect(stateOf(pick)).toBe("queued");
});

test("an assignment event without a mark, from before the marks, is held as a pick", async () => {
  const { app } = standIn;
  const repo = await pacedRepo("oldmark", 70);
  for (let i = 0; i < 2; i++) {
    const issue = openIssue(app, standIn.alice, repo, { title: `build ${i}`, body: "x" });
    if (!issue.ok) throw new Error(String(issue.error));
    claimRun(app.db, createRun(app.db, { repoId: repo.id, kind: "agent", issueId: issue.value.id, reason: "push", actorId: standIn.bot.id }).id);
  }
  const old = assigned(repo, "Queued before the mark", false);
  app.db.query("UPDATE event SET payload = json_remove(payload, '$.person') WHERE repo_id = ?1 AND kind LIKE '%.assigned'").run(repo.id);
  await until(() => logOf(old).includes("queued, not started: Ahead of pace"), "the unmarked run to be held");
  expect(stateOf(old)).toBe("queued");
});

test("at the reserve's wall everything waits, reviews and a person's assignment too", async () => {
  const { app } = standIn;
  const repo = await pacedRepo("wall", 95);
  const person = assigned(repo, "A person's issue", false);
  const review = createRun(app.db, { repoId: repo.id, kind: "agent", reason: "review", actorId: standIn.bot.id }).id;
  await until(() => logOf(person).includes("queued, not started:") && logOf(review).includes("queued, not started:"), "both to be held");
  expect(stateOf(person)).toBe("queued");
  expect(stateOf(review)).toBe("queued");
});
