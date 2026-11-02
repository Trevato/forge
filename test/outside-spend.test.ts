/**
 * Spend reported from outside is a claim kept apart (#7593): `reportSpend`
 * records it as said, `readReturns` shows it in `outside` only, and no
 * limit the crew is paced by — the repository's daily ceiling, the forge's,
 * the account's, the subscription's budget and standing, the governor —
 * reads it. Every read is the real one, snapshotted before and after a
 * report big enough to trip each limit were it ever added in.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { readReturns, reportSpend } from "../src/actions/returns.ts";
import { daySpent, dailyLeft, setAccountCeiling } from "../src/core/account_ceiling.ts";
import type { Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { standings } from "../src/core/standing.ts";
import { addSubscription, budgetsOf, setBudget } from "../src/core/subscriptions.ts";
import { recordUsage, usageTotals } from "../src/core/usage.ts";
import { createUser, type User } from "../src/core/users.ts";
import { autonomyStatus, spentToday, spentTodayEverywhere } from "../src/crew/autonomy.ts";
import { governorFor } from "../src/crew/governed.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir = "";
let app: App;
let alice: User;
let bob: User;
let repo: Repo;
let secret: Repo;
let issue: Issue;
let subscriptionId = "";
/** The crew's own spend: one $2 run, today. */
const RUN_USD = 2;
/** A claim far past every limit below; were it added in, each would move. */
const CLAIM_USD = 9_999.5;

async function person(username: string, admin = false): Promise<User> {
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username,
    email: `${username}@forge.local`,
    password: "a-good-passphrase",
    adminIfFirst: admin,
  });
  if (!made.ok) throw new Error(made.error);
  return made.value;
}

/** Every spend read a limit or a page takes, at one instant. */
function reads(now: Date) {
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  const returns = readReturns(app, alice, { repo: "alice/mill", days: 1, now });
  if (!returns.ok) throw new Error(returns.error);
  const { outside: _outside, ...crew } = returns.value;
  return {
    returns: crew,
    spentToday: spentToday(app.db, repo.id, now),
    spentEverywhere: spentTodayEverywhere(app.db, now),
    status: autonomyStatus(app, getRepoById(app.db, repo.id)!, now),
    daySpent: daySpent(app.db, alice.id, now),
    dailyLeft: dailyLeft(app.db, alice.id, now),
    usage: usageTotals(app.db, "repo", { since, repoId: repo.id }),
    budget: budgetsOf(app.db).get(subscriptionId),
    standing: standings(app.db, [subscriptionId], now).get(subscriptionId),
    governor: governorFor(app, getRepoById(app.db, repo.id)!, now),
  };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-outside-spend-"));
  app = createApp({ dataDir, port: 0 });
  alice = await person("alice", true);
  bob = await person("bob");
  const made = await createRepo(app, alice, { name: "mill", visibility: "public" });
  const hidden = await createRepo(app, alice, { name: "vault", visibility: "private" });
  if (!made.ok || !hidden.ok) throw new Error("repos");
  repo = made.value;
  secret = hidden.value;
  const agent = await createAgent(app, alice, { username: "bot" });
  if (!agent.ok) throw new Error(String(agent.error));
  expect(addToCrew(app, alice, repo, "bot").ok).toBe(true);
  const on = await updateRepoSettings(app, alice, repo, {
    autonomy: "autonomous",
    autonomyDirection: "Grind the grain",
    autonomyCeilingUsd: 5,
    autonomySlots: 3,
    autonomyBy: alice.id,
  });
  expect(on.ok).toBe(true);
  const opened = openIssue(app, alice, repo, { title: "Mill the flour" });
  if (!opened.ok) throw new Error(String(opened.error));
  issue = opened.value;
  const sub = addSubscription(app.db, dataDir, { name: "work-plan", token: "sk-ant-api-test-token" });
  if (!sub.ok) throw new Error(sub.error);
  subscriptionId = sub.value.id;
  expect(setBudget(app.db, subscriptionId, 10)).toBe(true);
  expect(setAccountCeiling(app.db, alice.id, 5, 5, alice.id, new Date())).toBe(true);

  const run = createRun(app.db, {
    repoId: repo.id,
    kind: "agent",
    issueId: issue.id,
    branch: "",
    actorId: agent.value.user.id,
    reason: "assigned",
  });
  const at = new Date().toISOString();
  app.db
    .query(`UPDATE run SET state = 'ok', cost_usd = ?2, summary = 'ok', started_at = ?3, finished_at = ?3 WHERE id = ?1`)
    .run(run.id, RUN_USD, at);
  recordUsage(app.db, {
    runId: run.id,
    repoId: repo.id,
    issueId: issue.id,
    agentId: agent.value.user.id,
    subscriptionId,
    tokensIn: 5_000,
    tokensOut: 1_000,
    costUsd: RUN_USD,
    wallMs: 60_000,
    outcome: "ok",
    at,
  });
});

afterAll(async () => {
  app.close?.();
  await rm(dataDir, { recursive: true, force: true });
});

test("who may report: no one signed in is unauthorized; a reader and a stranger are not_found", () => {
  const claim = { who: "the build team", usd: 1 };
  const none = reportSpend(app, undefined, repo, claim);
  expect(none).toEqual({ ok: false, error: "unauthorized" });
  // bob reads the public mill, and is a stranger to the private vault.
  expect(reportSpend(app, bob, repo, claim)).toEqual({ ok: false, error: "not_found" });
  expect(reportSpend(app, bob, secret, claim)).toEqual({ ok: false, error: "not_found" });
  const kept = app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM outside_spend").get()!.n;
  expect(kept).toBe(0);
});

test("a bad amount, a missing who or an unknown issue is invalid", () => {
  for (const input of [
    { who: "the build team", usd: -1 },
    { who: "the build team", usd: 10_000.01 },
    { who: "the build team", usd: Number.NaN },
    { who: "the build team", usd: "3" },
    { who: "the build team" },
    { who: "the build team", usd: 1, tokensIn: 1.5 },
    { who: "", usd: 1 },
    { who: "the build team", usd: 1, issue: 999 },
  ]) {
    expect(reportSpend(app, alice, repo, input)).toEqual({ ok: false, error: "invalid" });
  }
  const kept = app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM outside_spend").get()!.n;
  expect(kept).toBe(0);
});

test("a report is kept as said, shown apart, and moves no total and no limit", () => {
  const now = new Date(Date.now() + 1_000);
  const before = reads(now);
  // The fixture sits under every limit, so a claim added in would trip each.
  expect(before.spentToday).toBe(RUN_USD);
  expect(before.status.paused).toBeNull();
  expect(before.dailyLeft).toBe(3);
  expect(before.returns.spent.usd).toBe(RUN_USD);

  const made = reportSpend(app, alice, repo, {
    who: "the build team",
    model: "claude-opus-5-5",
    tokensIn: 120_000,
    tokensOut: 30_000,
    usd: CLAIM_USD,
    issue: issue.number,
    note: "a long session at home",
  });
  if (!made.ok) throw new Error(made.error);
  expect(made.value).toMatchObject({
    repoId: repo.id,
    issueId: issue.id,
    reporterId: alice.id,
    who: "the build team",
    usd: CLAIM_USD,
  });

  // Read back from the table exactly as said: amount, issue, who said it.
  const row = app.db
    .query<Record<string, unknown>, [string]>(
      `SELECT repo_id, issue_id, reporter_id, who, model, tokens_in, tokens_out, usd, note
       FROM outside_spend WHERE id = ?1`,
    )
    .get(made.value.id);
  expect(row).toEqual({
    repo_id: repo.id,
    issue_id: issue.id,
    reporter_id: alice.id,
    who: "the build team",
    model: "claude-opus-5-5",
    tokens_in: 120_000,
    tokens_out: 30_000,
    usd: CLAIM_USD,
    note: "a long session at home",
  });

  const after = reads(now);
  expect(after).toEqual(before);
  expect(after.status.paused).toBeNull();

  // The claim appears only in its own field.
  const returns = readReturns(app, alice, { repo: "alice/mill", days: 1, now });
  if (!returns.ok) throw new Error(returns.error);
  expect(returns.value.outside).toEqual([
    { who: "the build team", reports: 1, tokensIn: 120_000, tokensOut: 30_000, usd: CLAIM_USD },
  ]);
  expect(returns.value.spent).toEqual({ runs: 1, usd: RUN_USD });
});
