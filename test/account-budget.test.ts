/**
 * Each account has its own daily and per-run model spend ceiling, checked
 * before a run starts (#897).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { addToCrew } from "../src/actions/crew.ts";
import { addOwnModel, setAccountCeilings } from "../src/actions/model_grant.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { createOrg } from "../src/core/orgs.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { recordUsage } from "../src/core/usage.ts";
import {
  checkCeiling,
  dailyLeft,
  getAccountCeiling,
} from "../src/core/account_ceiling.ts";
import { PLATFORM } from "../src/core/subscriptions.ts";
import { readRunLog } from "../src/runs/log.ts";
import {
  agentRunSettled,
  startStandInCrew,
  stopStandInCrew,
  type StandInCrew,
} from "./helpers/crew-standin.ts";
import { promote } from "./helpers/members.ts";

describe("per-account spend ceilings", () => {
  let standIn: StandInCrew;
  let app: App;
  let admin: User;
  let bot: User;
  let n = 0;

  beforeAll(async () => {
    standIn = await startStandInCrew();
    ({ app, alice: admin, bot } = standIn);
  }, 30_000);
  afterAll(() => stopStandInCrew(standIn));

  async function person(name: string): Promise<{ user: User; repo: Repo }> {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: name,
      email: `${name}@forge.local`,
      password: "a-good-passphrase",
    });
    if (!made.ok) throw new Error(made.error);
    const user = made.value;
    promote(app.db, user);
    const r = await createRepo(app, user, { name: "yard", visibility: "private" });
    if (!r.ok) throw new Error(String(r.error));
    const seeded = await commitToBranch(app, user, r.value, {
      message: "Start",
      files: [{ path: "README.md", content: "# yard\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    expect(addToCrew(app, user, r.value, "bot").ok).toBe(true);
    expect(addOwnModel(app, user, { token: "sk-ant-api03-ownkey" }).ok).toBe(true);
    return { user, repo: r.value };
  }

  async function runOn(user: User, repo: Repo) {
    const issue = openIssue(app, user, repo, { title: `Job ${++n}`, body: "Soon." });
    if (!issue.ok) throw new Error(String(issue.error));
    expect(assignIssue(app, user, repo, issue.value, bot).ok).toBe(true);
    return agentRunSettled(app, repo, (r) => r.issueId === issue.value.id);
  }

  function spend(repo: Repo, usd: number): void {
    recordUsage(app.db, {
      runId: null,
      repoId: repo.id,
      issueId: null,
      agentId: null,
      subscriptionId: PLATFORM,
      tokensIn: 1,
      tokensOut: 1,
      costUsd: usd,
      wallMs: 1,
      outcome: "ok",
      at: new Date().toISOString(),
    } as never);
  }

  test("an account nobody set has no ceiling, an admin's own crew included", async () => {
    const { user } = await person("dee");
    expect(getAccountCeiling(app.db, user.id)).toBeUndefined();
    expect(dailyLeft(app.db, user.id, new Date())).toBeUndefined();
    expect(checkCeiling(app.db, user.id, 0.25, new Date())).toEqual({ ok: true, capUsd: undefined });
    // The admin owns repositories too; a spend far past any default does not stop them.
    const mine = await createRepo(app, admin, { name: "crewwork", visibility: "private" });
    if (!mine.ok) throw new Error(String(mine.error));
    spend(mine.value, 500);
    expect(checkCeiling(app.db, admin.id, 0.25, new Date())).toEqual({ ok: true, capUsd: undefined });
  });

  test("an admin sets an organization's ceiling, and it is what the runner checks", () => {
    const org = createOrg(app.db, "yardorg", admin.id);
    if (!org.ok) throw new Error(String(org.error));
    expect(setAccountCeilings(app, admin, "yardorg", 9, 2).ok).toBe(true);
    const id = getUserByName(app.db, "yardorg")!.id;
    expect(checkCeiling(app.db, id, 0.25, new Date())).toEqual({ ok: true, capUsd: 2 });
  });

  test("an account at its daily ceiling cannot start a run; another's spend does not count", async () => {
    const a = await person("ann");
    const b = await person("bob");
    expect(setAccountCeilings(app, admin, "ann", 3, 2).ok).toBe(true);
    spend(a.repo, 3);
    expect(dailyLeft(app.db, a.user.id, new Date())).toBe(0);
    const stopped = await runOn(a.user, a.repo);
    expect(stopped.state).toBe("failed");
    expect(stopped.summary).toContain("daily ceiling");
    expect(existsSync(standIn.argsFile)).toBe(false);
    // Bob is untouched by Ann's spend.
    expect(dailyLeft(app.db, b.user.id, new Date())).toBeUndefined();
    const ran = await runOn(b.user, b.repo);
    expect(ran.summary).not.toContain("ceiling");
  }, 90_000);

  test("a run is capped at the per-run ceiling, or refused when that is too small", async () => {
    const { user, repo } = await person("pru");
    expect(setAccountCeilings(app, admin, "pru", 50, 1.5).ok).toBe(true);
    expect(checkCeiling(app.db, user.id, 0.25, new Date())).toEqual({ ok: true, capUsd: 1.5 });
    spend(repo, 49.5); // 0.50 left of the day: the day's rest is the cap
    expect(checkCeiling(app.db, user.id, 0.25, new Date())).toEqual({ ok: true, capUsd: 0.5 });
    expect(setAccountCeilings(app, admin, "pru", 50, 0.1).ok).toBe(true);
    const v = checkCeiling(app.db, user.id, 0.25, new Date());
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.said).toContain("per-run ceiling");
    const run = await runOn(user, repo);
    expect(run.summary).toContain("per-run ceiling");
    expect(readRunLog(standIn.dataDir, run.id).lines.join("\n")).toContain("per-run ceiling");
  }, 90_000);

  test("the agent is handed the per-run ceiling as its budget, below the stand-in's own", async () => {
    const { user, repo } = await person("cap");
    expect(setAccountCeilings(app, admin, "cap", 50, 0.6).ok).toBe(true);
    const run = await runOn(user, repo);
    expect(run.summary).not.toContain("ceiling");
    expect(readRunLog(standIn.dataDir, run.id).lines.join("\n")).toContain("claude: budget $0.60");
  }, 90_000);

  test("only an admin sets ceilings, amounts are validated, and who set them is recorded", async () => {
    const { user } = await person("val");
    expect(setAccountCeilings(app, user, "val", 5, 1).ok).toBe(false);
    for (const bad of [0, -1, NaN, Infinity, 1e9]) {
      expect(setAccountCeilings(app, admin, "val", bad, 1).ok).toBe(false);
      expect(setAccountCeilings(app, admin, "val", 5, bad).ok).toBe(false);
    }
    expect(setAccountCeilings(app, admin, "nobody", 5, 1).ok).toBe(false);
    expect(getAccountCeiling(app.db, user.id)).toBeUndefined();
    expect(setAccountCeilings(app, admin, "val", 7.5, 2).ok).toBe(true);
    const event = app.db
      .query<{ payload: string; actor_id: string }, []>(
        "SELECT payload, actor_id FROM event WHERE kind = 'account.ceiling_set' ORDER BY id DESC LIMIT 1",
      )
      .get()!;
    expect(event.actor_id).toBe(admin.id);
    expect(JSON.parse(event.payload)).toEqual({ username: "val", dailyUsd: 7.5, perRunUsd: 2 });
    const row = app.db
      .query<{ set_by: string }, [string]>("SELECT set_by FROM account_ceiling WHERE user_id = ?1")
      .get(user.id)!;
    expect(row.set_by).toBe(admin.id);
  });

  test("a run under way stops when the day's ceiling is spent, and says so", async () => {
    const { user, repo } = await person("tick");
    expect(setAccountCeilings(app, admin, "tick", 4, 4).ok).toBe(true);
    const issue = openIssue(app, user, repo, { title: "Slow job", body: "GRANT-TICK until told." });
    if (!issue.ok) throw new Error(String(issue.error));
    expect(assignIssue(app, user, repo, issue.value, bot).ok).toBe(true);
    const settled = agentRunSettled(app, repo, (r) => r.issueId === issue.value.id);
    for (let i = 0; i < 200 && !existsSync(join(standIn.dataDir, "ticked")); i++)
      await Bun.sleep(100);
    expect(existsSync(join(standIn.dataDir, "ticked"))).toBe(true);
    expect(dailyLeft(app.db, user.id, new Date())).toBe(4);
    spend(repo, 4);
    writeFileSync(join(standIn.dataDir, "spent"), "");
    const run = await settled;
    expect(run.state).toBe("failed");
    expect(run.summary).toContain("daily ceiling is spent");
    expect(run.summary).toContain("the run stopped");
  }, 90_000);
});
