/**
 * A run picks its model from the work (#7570): P0 or `opus`-labelled work,
 * a planner's pass handed work and a pull sent back twice run on Opus; a planner's plain pass on Sonnet; the rest on the
 * agent's own model. The run row records which and why, and the scorecard
 * reads spend and landed pulls per model per day.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { chooseModel, modelFacts } from "../src/crew/model_choice.ts";
import { addDependency } from "../src/core/dependencies.ts";
import { createIssue, createLabel, setIssueLabels, type Issue } from "../src/core/issues.ts";
import { modelDays } from "../src/core/model_days.ts";
import { submitReview } from "../src/core/reviews.ts";
import { claimRun, createRun, finishRun, noteRunProgress } from "../src/core/runs.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { readScorecards } from "../src/actions/scorecard.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const plain = {
  agentModel: "sonnet",
  role: "builder",
  p0: false,
  labelled: false,
  bouncedRounds: 0,
  handed: false,
};

describe("which model a run uses", () => {
  test("an ordinary run uses the agent's own model", () => {
    expect(chooseModel(plain)).toEqual({ model: "sonnet", reason: "agent" });
    expect(chooseModel({ ...plain, agentModel: "" })).toEqual({ model: "", reason: "agent" });
    expect(chooseModel({ ...plain, bouncedRounds: 1 }).reason).toBe("agent");
  });

  test("P0, the opus label, the planner and a twice-bounced pull use opus", () => {
    expect(chooseModel({ ...plain, p0: true })).toEqual({ model: "opus", reason: "p0" });
    expect(chooseModel({ ...plain, labelled: true }).reason).toBe("label:opus");
    expect(chooseModel({ ...plain, role: "planner", handed: true })).toEqual({ model: "opus", reason: "planner:handed" });
    expect(chooseModel({ ...plain, role: "planner", agentModel: "opus" })).toEqual({ model: "sonnet", reason: "planner" });
    expect(chooseModel({ ...plain, bouncedRounds: 2 })).toEqual({
      model: "opus",
      reason: "bounced:2",
    });
  });
});

describe("the facts of the work", () => {
  let dataDir: string;
  let app: App;
  let repo: Repo;
  let admin: User;

  const open = (title: string, kind: "issue" | "pull" = "issue"): Issue => {
    const made = createIssue(app.db, { repoId: repo.id, authorId: admin.id, title, kind });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-model-choice-"));
    app = createApp({ dataDir, port: 0 });
    const ada = await seedAdmin(app, { username: "ada", email: "ada@forge.example" });
    if (!ada.ok) throw new Error(ada.error);
    admin = ada.value;
    const made = await createRepo(app, admin, { name: "hello", visibility: "public" });
    if (!made.ok) throw new Error(JSON.stringify(made.error));
    repo = getRepoById(app.db, made.value.id)!;
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an issue serving P0 picks opus, one serving P1 does not", () => {
    const trust = open("P0 Trust: contained");
    const feed = open("P1 Feed: front door");
    const urgent = open("Contain the cell");
    const calm = open("Tidy the feed");
    addDependency(app.db, trust, urgent, admin.id);
    addDependency(app.db, feed, calm, admin.id);
    const pick = (i: Issue) =>
      chooseModel(modelFacts(app.db, repo, [i], "sonnet", "builder"));
    expect(pick(urgent)).toEqual({ model: "opus", reason: "p0" });
    expect(pick(calm)).toEqual({ model: "sonnet", reason: "agent" });
  });

  test("the opus label picks opus", () => {
    const labelled = open("Hard one");
    const label = createLabel(app.db, repo.id, "opus", "7c3aed");
    if (!label.ok) throw new Error(label.error);
    setIssueLabels(app.db, labelled.id, [label.value.id]);
    expect(
      chooseModel(modelFacts(app.db, repo, [labelled], "sonnet", "builder")).reason,
    ).toBe("label:opus");
  });

  test("a pull sent back twice picks opus for its next round", () => {
    const pull = open("A change", "pull");
    const review = (state: "changes_requested" | "approved") =>
      submitReview(app.db, { issueId: pull.id, authorId: admin.id, state, commitOid: "a" });
    const pick = () => chooseModel(modelFacts(app.db, repo, [pull], "sonnet", "builder"));
    review("changes_requested");
    expect(pick().reason).toBe("agent");
    review("changes_requested");
    expect(pick()).toEqual({ model: "opus", reason: "bounced:2" });
  });

  test("a reviewer on a twice-bounced pull gets the agent's own model", () => {
    const pull = open("Reviewed", "pull");
    for (let n = 0; n < 2; n++)
      submitReview(app.db, { issueId: pull.id, authorId: admin.id, state: "changes_requested", commitOid: "a" });
    const pick = (reviewing: boolean) =>
      chooseModel(modelFacts(app.db, repo, [pull], "sonnet", "reviewer", reviewing));
    expect(pick(false).reason).toBe("bounced:2");
    expect(pick(true)).toEqual({ model: "sonnet", reason: "agent" });
  });

  test("a landed pull counts on its merge day under the latest run's model", () => {
    const pull = open("Landed", "pull");
    for (const model of ["sonnet", "opus"]) {
      const run = createRun(app.db, { repoId: repo.id, kind: "agent", issueId: pull.id, actorId: admin.id });
      claimRun(app.db, run.id);
      noteRunProgress(app.db, run.id, { model });
      finishRun(app.db, run.id, { state: "ok", summary: "" });
    }
    const merged = new Date(Date.now() - 86_400_000).toISOString();
    app.db
      .query(
        `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at)
         VALUES (?1, 'main', 'landed', 'a', 'b', ?2)`,
      )
      .run(pull.id, merged);
    const days = modelDays(app.db, 7);
    const landed = days.filter((d) => d.landed > 0);
    expect(landed).toEqual([
      expect.objectContaining({ day: merged.slice(0, 10), model: "opus", landed: 1 }),
    ]);
  });

  test("the run records the model and why; the scorecard reads spend and landed per model per day", () => {
    const run = createRun(app.db, { repoId: repo.id, kind: "agent", issueId: open("Work").id, actorId: admin.id });
    claimRun(app.db, run.id);
    noteRunProgress(app.db, run.id, { model: "opus", modelReason: "p0", costUsd: 1.5 });
    finishRun(app.db, run.id, { state: "ok", summary: "done" });
    const row = app.db
      .query<{ model: string; model_reason: string }, [string]>(
        "SELECT model, model_reason FROM run WHERE id = ?1",
      )
      .get(run.id)!;
    expect(row).toEqual({ model: "opus", model_reason: "p0" });
    const days = modelDays(app.db);
    const today = new Date().toISOString().slice(0, 10);
    expect(days.find((d) => d.day === today && d.model === "opus")).toMatchObject({
      runs: 2,
      spentUsd: 1.5,
    });
    expect(readScorecards(app, admin)?.modelDays).toEqual(days);
  });
});
