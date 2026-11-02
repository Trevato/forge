/**
 * Cross-team work (#2681): an issue names up to two teams; the pull that
 * closes it queues one review per team, the pull page shows both verdicts,
 * and the naming is a writer's, validated at the boundary.
 */

import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { nameTeams } from "../src/actions/issue_teams.ts";
import { openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import {} from "../src/core/agents.ts";
import { teamsOfIssue, teamVerdicts } from "../src/core/issue_teams.ts";
import type { Issue } from "../src/core/issues.ts";
import type { Pull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { submitReview } from "../src/core/reviews.ts";
import { claimRun, createRun, finishRun, listRuns } from "../src/core/runs.ts";
import { saveTeam } from "../src/core/teams.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { sendToReview } from "../src/crew/review.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("cross-team work", () => {
  let dataDir = "";
  let app: App;
  let alice: User;
  let repo: Repo;
  let n = 0;
  const fresh = () => getRepoById(app.db, repo.id)!;
  const id = (name: string) => getUserByName(app.db, name)!.id;

  const issueNaming = (teams: string[]): Issue => {
    const o = openIssue(app, alice, repo, { title: "A chart" });
    if (!o.ok) throw new Error(o.error);
    const set = nameTeams(app, alice, repo, o.value, teams);
    if (!set.ok) throw new Error(set.error);
    return o.value;
  };
  const pullClosing = async (issue: Issue): Promise<Pull> => {
    const branch = `b${++n}`;
    const c = await commitToBranch(app, alice, repo, {
      branch,
      base: "main",
      message: branch,
      files: [{ path: `${branch}.md`, content: "x\n" }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    const o = await openPull(app, alice, repo, {
      title: branch,
      body: `Closes #${issue.number}`,
      baseBranch: "main",
      headBranch: branch,
    });
    if (!o.ok) throw new Error(String(o.error));
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: o.value.id,
      env: `pull-${o.value.number}`,
      commitOid: o.value.headOid,
      reason: "pull",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "ok", summary: "ok" });
    return { ...o.value, authorIsAgent: true };
  };
  const reviewRuns = (pull: Pull) =>
    listRuns(app.db, repo.id, { issueId: pull.id }).filter((r) => r.reason === "review");

  /** Run one setup or teardown step; a failure names the step, so a red check says which. */
  const step = async <T>(name: string, work: () => T | Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      throw new Error(`issue-teams ${name} failed: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  };

  beforeAll(async () => {
    await step("seed", async () => {
      dataDir = await mkdtemp(join(tmpdir(), "forge-issue-teams-"));
      app = createApp({ dataDir, port: 0 });
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username: "alice",
        email: "alice@forge.local",
        password: "a-good-passphrase",
        adminIfFirst: true,
      });
      if (!made.ok) throw new Error(made.error);
      alice = made.value;
      const r = await createRepo(app, alice, { name: "garden", visibility: "private" });
      if (!r.ok) throw new Error(String(r.error));
      repo = r.value;
      const seeded = await commitToBranch(app, alice, repo, {
        message: "seed",
        files: [{ path: "README.md", content: "# garden\n" }],
      });
      if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    });
    await step("agents", async () => {
      for (const name of ["quill", "pike"]) {
        const agent = await createAgent(app, alice, { username: name });
        if (!agent.ok) throw new Error(String(agent.error));
        addToCrew(app, alice, repo, name);
        seatAs(app.db, repo.id, id(name), "reviewer");
      }
    });
    await step("teams", () => {
      saveTeam(app.db, "design", { charter: "", dial: 0, members: [id("quill")] });
      saveTeam(app.db, "data-science", { charter: "", dial: 0, members: [id("pike")] });
    });
  }, 120_000);

  afterAll(async () => {
    await step("close", async () => {
      // A push starts work nobody holds a handle to (pull heads following it,
      // reader processes); let it finish before the database closes under it
      // and the data dir goes, so load cannot turn it into a hook failure.
      for (let i = 0; i < 20; i++) await new Promise((done) => setImmediate(done));
      await Bun.sleep(100);
      app?.close();
      if (dataDir !== "") await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });
  }, 30_000);

  test("an issue names at most two real teams", () => {
    const o = openIssue(app, alice, repo, { title: "Chart" });
    if (!o.ok) throw new Error(o.error);
    const set = (t: string[]) => nameTeams(app, alice, repo, o.value, t);
    expect(set(["design", "security", "platform"])).toEqual({ ok: false, error: "too_many" });
    expect(set(["design", "nope"])).toEqual({ ok: false, error: "no_such_team" });
    expect(teamsOfIssue(app.db, o.value.id)).toEqual([]);
    expect(set(["design", "data-science", "design"]).ok).toBe(true);
    expect(teamsOfIssue(app.db, o.value.id)).toEqual(["design", "data-science"]);
  });

  test("a stranger cannot name teams", () => {
    const o = openIssue(app, alice, repo, { title: "Chart" });
    if (!o.ok) throw new Error(o.error);
    expect(nameTeams(app, undefined, repo, o.value, ["design"]).ok).toBe(false);
  });

  test("an issue naming two teams queues one review per team on its pull", async () => {
    const pull = await pullClosing(issueNaming(["design", "data-science"]));
    expect(await sendToReview(app, fresh(), pull)).toBe("sent");
    const runs = reviewRuns(pull);
    expect(runs.map((r) => r.actorId).sort()).toEqual([id("quill"), id("pike")].sort());
    // Nothing more to send while both are out.
    expect(await sendToReview(app, fresh(), pull)).toBe("wait");
    expect(reviewRuns(pull)).toHaveLength(2);
  });

  test("one team's approval does not stand in for the other's", async () => {
    const pull = await pullClosing(issueNaming(["design", "data-science"]));
    await sendToReview(app, fresh(), pull);
    submitReview(app.db, { issueId: pull.id, authorId: id("quill"), state: "approved", commitOid: pull.headOid });
    const verdicts = teamVerdicts(app.db, pull);
    expect(verdicts.map((v) => [v.team, v.state])).toEqual([
      ["design", "approved"],
      ["data-science", undefined],
    ]);
    // Data science is still owed: its run is out, so the pull waits, not done.
    expect(await sendToReview(app, fresh(), pull)).toBe("wait");
    submitReview(app.db, { issueId: pull.id, authorId: id("pike"), state: "changes_requested", commitOid: pull.headOid });
    expect(teamVerdicts(app.db, pull).map((v) => v.state)).toEqual(["approved", "changes_requested"]);
    expect(await sendToReview(app, fresh(), pull)).toBe("done");
  });

  test("an approval followed by a comment still answers for the team", async () => {
    const pull = await pullClosing(issueNaming(["design"]));
    submitReview(app.db, { issueId: pull.id, authorId: id("quill"), state: "approved", commitOid: pull.headOid });
    submitReview(app.db, { issueId: pull.id, authorId: id("quill"), state: "commented", body: "nit", commitOid: pull.headOid });
    expect(teamVerdicts(app.db, pull).map((v) => v.state)).toEqual(["approved"]);
    expect(await sendToReview(app, fresh(), pull)).toBe("done");
    expect(reviewRuns(pull)).toHaveLength(0);
  });

  test("one reviewer on both named teams is asked once", async () => {
    const agent = await createAgent(app, alice, { username: "ember" });
    if (!agent.ok) throw new Error(String(agent.error));
    addToCrew(app, alice, repo, "ember");
    seatAs(app.db, repo.id, id("ember"), "reviewer");
    saveTeam(app.db, "security", { charter: "", dial: 0, members: [id("ember")] });
    saveTeam(app.db, "platform", { charter: "", dial: 0, members: [id("ember")] });
    const pull = await pullClosing(issueNaming(["security", "platform"]));
    expect(await sendToReview(app, fresh(), pull)).toBe("sent");
    expect(reviewRuns(pull).map((r) => r.actorId)).toEqual([id("ember")]);
    expect(await sendToReview(app, fresh(), pull)).toBe("wait");
    expect(reviewRuns(pull)).toHaveLength(1);
  });

  test("an issue naming no team is reviewed as before", async () => {
    const pull = await pullClosing(issueNaming([]));
    expect(await sendToReview(app, fresh(), pull)).toBe("sent");
    expect(reviewRuns(pull)).toHaveLength(1);
  });
});
