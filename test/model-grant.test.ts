/**
 * A new account has a model budget of zero; it runs a crew only on its own
 * subscription or on a capped grant an admin gave it (#1145).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { addToCrew } from "../src/actions/crew.ts";
import { addOwnModel, setAccountGrant } from "../src/actions/model_grant.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { createOrg } from "../src/core/orgs.ts";
import { createUser } from "../src/core/users.ts";
import { recordUsage } from "../src/core/usage.ts";
import { budgetLine, grantLeft, monthSpent } from "../src/core/model_grant.ts";
import { PLATFORM } from "../src/core/subscriptions.ts";
import { readRunLog } from "../src/runs/log.ts";
import {
  agentRunSettled,
  startStandInCrew,
  stopStandInCrew,
  type StandInCrew,
} from "./helpers/crew-standin.ts";
import { promote } from "./helpers/members.ts";

describe("model budget: zero, an own subscription, a capped grant", () => {
  let standIn: StandInCrew;
  let app: App;
  let admin: User;
  let bot: User;
  let n = 0;
  /** A run that spent nothing, whose ledger line a test may borrow. */
  let zeroRun = "";

  beforeAll(async () => {
    standIn = await startStandInCrew();
    ({ app, alice: admin, bot } = standIn);
    process.env.ANTHROPIC_API_KEY = "sk-forge-own-token";
  }, 30_000);

  afterAll(() => {
    delete process.env.ANTHROPIC_API_KEY;
    return stopStandInCrew(standIn);
  });

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
    return { user, repo: r.value };
  }

  async function runOn(user: User, repo: Repo) {
    const issue = openIssue(app, user, repo, { title: `Job ${++n}`, body: "Soon." });
    if (!issue.ok) throw new Error(String(issue.error));
    expect(assignIssue(app, user, repo, issue.value, bot).ok).toBe(true);
    return agentRunSettled(app, repo, (r) => r.issueId === issue.value.id);
  }

  test("a new account has zero, says so, and its run is refused", async () => {
    const { user, repo } = await person("zed");
    expect(budgetLine(app.db, user, new Date())).toContain("Model budget: $0.");
    const run = await runOn(user, repo);
    expect(run.state).toBe("failed");
    zeroRun = run.id;
    expect(run.summary).toContain("This repository has no model account");
    expect(existsSync(standIn.argsFile)).toBe(false);
  }, 60_000);

  test("an own subscription runs, for its own repositories only", async () => {
    const { user, repo } = await person("own");
    const other = await person("else");
    const added = addOwnModel(app, user, { token: "sk-ant-api03-ownkey" });
    expect(added.ok).toBe(true);
    expect(budgetLine(app.db, user, new Date())).toContain("own subscription");
    const run = await runOn(user, repo);
    expect(run.summary).not.toContain("no model account");
    expect(readRunLog(standIn.dataDir, run.id).lines.join("\n")).toContain(
      "subscription: own-own",
    );
    // Someone else's repository does not get it.
    const theirs = await runOn(other.user, other.repo);
    expect(theirs.summary).toContain("This repository has no model account");
  }, 90_000);

  test("only a forge admin who is a person gives a grant, and it is audited", async () => {
    const { user } = await person("gina");
    expect(setAccountGrant(app, user, "gina", 5).ok).toBe(false);
    expect(setAccountGrant(app, admin, "gina", 0).ok).toBe(false);
    expect(setAccountGrant(app, admin, "gina", 99999).ok).toBe(false);
    expect(setAccountGrant(app, admin, bot.username, 5).ok).toBe(false);
    expect(setAccountGrant(app, admin, "gina", 5).ok).toBe(true);
    const event = app.db
      .query<{ payload: string; actor_id: string }, []>(
        "SELECT payload, actor_id FROM event WHERE kind = 'account.model_granted' ORDER BY id DESC LIMIT 1",
      )
      .get()!;
    expect(event.actor_id).toBe(admin.id);
    expect(JSON.parse(event.payload)).toEqual({ username: "gina", usdPerMonth: 5 });
    expect(budgetLine(app.db, user, new Date())).toContain("$5.00 a month, $5.00 left");
  });

  test("a capped grant runs, and stops being offered at the cap", async () => {
    const { user, repo } = await person("cap");
    expect(setAccountGrant(app, admin, "cap", 5).ok).toBe(true);
    const run = await runOn(user, repo);
    expect(run.summary).not.toContain("no model account");
    expect(readRunLog(standIn.dataDir, run.id).lines.join("\n")).toContain(
      "model grant: $5.00 left this month",
    );

    // Spend the month's cap on the forge's credential: the next run is refused.
    recordUsage(app.db, {
      runId: run.id,
      repoId: repo.id,
      issueId: null,
      agentId: null,
      subscriptionId: PLATFORM,
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 5,
      wallMs: 1,
      outcome: "ok",
      at: new Date().toISOString(),
    });
    expect(grantLeft(app.db, user.id, new Date())).toBe(0);
    const refused = await runOn(user, repo);
    expect(refused.state).toBe("failed");
    expect(refused.summary).toContain("model grant is spent");
  }, 90_000);

  test("the cap is the month's: last month's spend does not count, taking it back ends it", async () => {
    const { user, repo } = await person("mo");
    setAccountGrant(app, admin, "mo", 2);
    recordUsage(app.db, {
      runId: zeroRun,
      repoId: repo.id,
      issueId: null,
      agentId: null,
      subscriptionId: PLATFORM,
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 9,
      wallMs: 1,
      outcome: "ok",
      at: "2020-01-15T00:00:00.000Z",
    });
    expect(monthSpent(app.db, user.id, new Date())).toBe(0);
    expect(grantLeft(app.db, user.id, new Date())).toBe(2);
    expect(setAccountGrant(app, admin, "mo", null).ok).toBe(true);
    expect(grantLeft(app.db, user.id, new Date())).toBeUndefined();
  });
  test("a running grant run crosses the cap mid-session, is stopped, and says the grant is spent", async () => {
    const { user, repo } = await person("tick");
    expect(setAccountGrant(app, admin, "tick", 5).ok).toBe(true);
    const issue = openIssue(app, user, repo, { title: "Slow job", body: "GRANT-TICK until told." });
    if (!issue.ok) throw new Error(String(issue.error));
    expect(assignIssue(app, user, repo, issue.value, bot).ok).toBe(true);
    const settled = agentRunSettled(app, repo, (r) => r.issueId === issue.value.id);
    for (let i = 0; i < 200 && !existsSync(join(standIn.dataDir, "ticked")); i++)
      await Bun.sleep(100);
    expect(existsSync(join(standIn.dataDir, "ticked"))).toBe(true);
    // The run is under its cap so far; the month's spend now reaches it.
    expect(grantLeft(app.db, user.id, new Date())).toBe(5);
    recordUsage(app.db, {
      runId: zeroRun,
      repoId: repo.id,
      issueId: null,
      agentId: null,
      subscriptionId: PLATFORM,
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 5,
      wallMs: 1,
      outcome: "ok",
      at: new Date().toISOString(),
    });
    writeFileSync(join(standIn.dataDir, "spent"), "");
    const run = await settled;
    expect(run.state).toBe("failed");
    expect(run.summary).toContain("model grant is spent");
    expect(run.summary).toContain("stopped at the cap");
  }, 90_000);

  test("an own subscription is found by its owner, not by its name", async () => {
    const { user } = await person("bob");
    const other = await person("carol");
    // A subscription someone else made with bob's name for it is not his.
    const { addSubscription } = await import("../src/core/subscriptions.ts");
    expect(
      addSubscription(app.db, standIn.dataDir, {
        name: "bob-own",
        token: "sk-ant-api03-adminmade",
        createdBy: admin.id,
      }).ok,
    ).toBe(true);
    const { ownSubscription } = await import("../src/core/model_grant.ts");
    expect(ownSubscription(app.db, user.id)).toBeUndefined();
    expect(budgetLine(app.db, user, new Date())).toContain("Model budget: $0.");
    expect(addOwnModel(app, user, { token: "sk-ant-api03-bobkey" }).ok).toBe(true);
    expect(ownSubscription(app.db, user.id)?.createdBy).toBe(user.id);
    expect(ownSubscription(app.db, other.user.id)).toBeUndefined();
    // One per account.
    const again = addOwnModel(app, user, { token: "sk-ant-api03-bobkey2" });
    expect(again.ok).toBe(false);
  });

  test("an org reaches the forge's account only by an admin's explicit grant; adding an admin to Owners grants nothing", async () => {
    const seed = async (owner: User, org: string, name: string) => {
      const made = await createRepo(app, owner, { name, owner: org, visibility: "private" });
      if (!made.ok) throw new Error(String(made.error));
      const seeded = await commitToBranch(app, owner, made.value, {
        message: "Start",
        files: [{ path: "README.md", content: `# ${name}\n` }],
      });
      if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
      expect(addToCrew(app, owner, made.value, "bot").ok).toBe(true);
      return made.value;
    };

    // A non-admin founds an org and puts a forge admin on Owners: still refused, the fix named.
    const { user: founder } = await person("founder");
    const theirs = createOrg(app.db, "plainorg", founder.id);
    if (!theirs.ok) throw new Error(String(theirs.error));
    const team = app.db
      .query<{ id: string }, [string]>("SELECT id FROM team WHERE org_id = ?1")
      .get(theirs.value.id)!;
    app.db.query("INSERT INTO team_member (team_id, user_id) VALUES (?1, ?2)").run(team.id, admin.id);
    const repo = await seed(founder, "plainorg", "shop");
    const refused = await runOn(founder, repo);
    expect(refused.state).toBe("failed");
    expect(refused.summary).toBe(
      "the account `plainorg` has no model grant; an admin can grant one at /settings/accounts/plainorg",
    );

    // The admin grants the org explicitly: its runs use the forge's account, up to the grant.
    expect(setAccountGrant(app, admin, "plainorg", 5).ok).toBe(true);
    const ran = await runOn(founder, repo);
    expect(ran.summary).not.toContain("no model grant");
    expect(readRunLog(standIn.dataDir, ran.id).lines.join("\n")).toContain("model grant: $");
  }, 90_000);
});
