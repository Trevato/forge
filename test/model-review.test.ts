/**
 * The weekly model review (#7815): from the ledger alone, one change per
 * agent per week, small samples change nothing, the owner's one button, a
 * result a week on, and an undo when quality fell.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { runModelReview, decideChange, readReview } from "../src/actions/model_review.ts";
import { readScorecards } from "../src/actions/scorecard.ts";
import { createAgentRow, getAgent } from "../src/core/agents.ts";
import { createIssue } from "../src/core/issues.ts";
import { getChange, recordChange, review, type ModelStats } from "../src/core/model_review.ts";
import { claimRun, createRun, finishRun, noteRunProgress } from "../src/core/runs.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { setLimit } from "../src/settings/limits.ts";
import { createRepo } from "../src/actions/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { adminCookie, seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const stats = (o: Partial<ModelStats> = {}): ModelStats => ({
  model: "opus", opened: 10, landed: 10, costPerLanded: 25, redRate: 0.1,
  reworkRounds: 0.2, reverts: 0, hardShare: 0.1, ...o,
});
const limits = { minLanded: 8, slackPct: 10 };

describe("the verdict, as plain code", () => {
  test("a small sample says so and changes nothing", () => {
    const v = review("opus", [stats({ landed: 3 })], limits);
    expect(v.kind).toBe("hold");
    expect(v.kind === "hold" && v.note).toContain("3 landed");
  });
  test("a healthy model steps one place down; the cheapest and unknown models hold", () => {
    expect(review("opus", [stats()], limits)).toMatchObject({ kind: "propose", to: "sonnet", direction: "down" });
    expect(review("haiku", [stats({ model: "haiku" })], limits).kind).toBe("hold");
    expect(review("", [], limits).kind).toBe("hold");
    expect(review("mystery", [], limits).kind).toBe("hold");
  });
  test("mostly hard work is not handed to a cheaper model", () => {
    expect(review("opus", [stats({ hardShare: 0.9 })], limits).kind).toBe("hold");
  });
  test("a model that reverts steps up, never down", () => {
    expect(review("sonnet", [stats({ model: "sonnet", reverts: 1 })], limits)).toMatchObject({ kind: "propose", to: "opus", direction: "up" });
  });
  test("a cheaper model with its own worse numbers stays where it is", () => {
    const v = review("opus", [stats(), stats({ model: "sonnet", costPerLanded: 1, redRate: 0.6 })], limits);
    expect(v.kind).toBe("hold");
  });
});

describe("the weekly review", () => {
  let dataDir: string;
  let app: App;
  let agent: User;
  let owner: User;
  let repoId = "";
  const t0 = new Date("2026-11-02T00:00:00Z");
  const day = (n: number) => new Date(t0.getTime() + n * 86_400_000);

  /** A landed pull by the agent on `model`, opened at `at`. */
  function landed(model: string, at: Date, o: { reverted?: boolean; red?: number; cost?: number } = {}): void {
    const issue = createIssue(app.db, { repoId, authorId: agent.id, title: `p${Math.random()}`, kind: "pull" });
    if (!issue.ok) throw new Error(issue.error);
    const id = issue.value.id;
    app.db.query("UPDATE issue SET created_at = ?2 WHERE id = ?1").run(id, at.toISOString());
    app.db
      .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at) VALUES (?1,'main',?2,'a','b',?3)`)
      .run(id, `h${issue.value.number}`, at.toISOString());
    const run = createRun(app.db, { repoId, kind: "agent", actorId: agent.id, issueId: id });
    claimRun(app.db, run.id);
    noteRunProgress(app.db, run.id, { model, modelReason: "agent", costUsd: o.cost ?? 1 });
    finishRun(app.db, run.id, { state: "ok", summary: "" });
    for (let i = 0; i < (o.red ?? 0); i++) {
      const c = createRun(app.db, { repoId, kind: "check", issueId: id });
      claimRun(app.db, c.id);
      finishRun(app.db, c.id, { state: "failed", summary: "" });
    }
    if (o.reverted) {
      const back = createIssue(app.db, { repoId, authorId: agent.id, title: "revert", kind: "pull" });
      if (!back.ok) throw new Error(back.error);
      app.db
        .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at, reverts_issue_id) VALUES (?1,'main',?2,'a','b',?3,?4)`)
        .run(back.value.id, `r${back.value.number}`, at.toISOString(), id);
    }
  }
  const many = (n: number, model: string, at: Date, o = {}) => {
    for (let i = 0; i < n; i++) landed(model, at, o);
  };

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-review-"));
    app = createApp({ dataDir, port: 0 });
    const made = await createUser(app.db, { username: "torque", email: "t@agents.invalid", password: "", displayName: "Torque", agent: true, origin: "agent" });
    if (!made.ok) throw new Error("user");
    agent = made.value;
    createAgentRow(app.db, { userId: agent.id, model: "opus", brief: "", budgetUsd: 0 });
    const ada = await seedAdmin(app, { username: "ada", email: "a@x.example" });
    if (!ada.ok) throw new Error("owner");
    owner = ada.value;
    const repo = await createRepo(app, owner, { name: "hello", visibility: "public" });
    if (!repo.ok) throw new Error(JSON.stringify(repo.error));
    repoId = repo.value.id;
  });
  afterEach(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const model = () => getAgent(app.db, agent.id)!.model;
  const events = (kind: string) =>
    app.db.query<{ payload: string }, [string]>("SELECT payload FROM event WHERE kind = ?1").all(kind);
  const admin = () => owner;

  test("too few landed: nothing changes, nothing is logged", () => {
    many(3, "opus", day(-3));
    expect(runModelReview(app, t0)).toEqual([]);
    expect(model()).toBe("opus");
    expect(readReview(app, t0).changes).toEqual([]);
  });

  test("a clean model asks with its numbers; the owner's button applies it; it runs once a week", () => {
    many(8, "opus", day(-3), { cost: 25 });
    const made = runModelReview(app, t0);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ state: "asked", fromModel: "opus", toModel: "sonnet" });
    expect(made[0]!.before.costPerLanded).toBe(25);
    expect(model()).toBe("opus");
    expect(events("crew.model_asked")).toHaveLength(1);
    // not again this week, and not two changes for one agent
    expect(runModelReview(app, day(3))).toEqual([]);
    expect(runModelReview(app, day(8))).toEqual([]);
    expect(decideChange(app, undefined, made[0]!.id, true).ok).toBe(false);
    const taken = decideChange(app, admin(), made[0]!.id, true, day(8));
    expect(taken.ok && taken.value.state).toBe("applied");
    expect(model()).toBe("sonnet");
    expect(events("crew.model_changed")[0]!.payload).toContain("before");
    expect(decideChange(app, admin(), made[0]!.id, true).ok).toBe(false);
  });

  test("declining leaves the model, and the next week may ask again", () => {
    many(8, "opus", day(-3));
    const [c] = runModelReview(app, t0);
    decideChange(app, admin(), c!.id, false, t0);
    expect(model()).toBe("opus");
    expect(runModelReview(app, day(7))).toHaveLength(1);
  });

  test("with the limit on, a step down applies itself and a week on is reported and kept", () => {
    setLimit(app.db, "model_review.auto", 1, agent.id);
    many(8, "opus", day(-3));
    const [c] = runModelReview(app, t0);
    expect(c!.state).toBe("applied");
    expect(model()).toBe("sonnet");
    many(8, "sonnet", day(1), { cost: 1 });
    runModelReview(app, day(8));
    const done = readReview(app, day(8)).changes.find((x) => x.id === c!.id)!;
    expect(done.state).toBe("kept");
    expect(done.after?.model).toBe("sonnet");
    expect(done.result).toContain("held on sonnet");
    // a change just settled counts as this week's move: no second one in the same tick
    expect(model()).toBe("sonnet");
    expect(events("crew.model_result")).toHaveLength(1);
    // a week later the healthy sonnet may step down once more, as its own change
    expect(runModelReview(app, day(16))).toHaveLength(1);
    expect(model()).toBe("haiku");
  });

  test("when quality fell a week on, the change is undone", () => {
    setLimit(app.db, "model_review.auto", 1, agent.id);
    many(8, "opus", day(-3));
    const [c] = runModelReview(app, t0);
    many(8, "sonnet", day(1), { reverted: true });
    runModelReview(app, day(8));
    const done = readReview(app, day(8)).changes.find((x) => x.id === c!.id)!;;
    expect(done.state).toBe("undone");
    expect(model()).toBe("opus");
    expect(done.result).toContain("quality fell");
  });

  test("a result with too few landed waits, then keeps the change after two weeks", () => {
    setLimit(app.db, "model_review.auto", 1, agent.id);
    many(8, "opus", day(-3));
    const [c] = runModelReview(app, t0);
    many(2, "sonnet", day(1));
    runModelReview(app, day(8));
    const stateAt = (n: number) => readReview(app, day(n)).changes.find((x) => x.id === c!.id)!.state;
    expect(stateAt(8)).toBe("applied");
    runModelReview(app, day(15));
    expect(stateAt(15)).toBe("kept");
  });

  test("an ask nobody answers lapses after two weeks as declined, and stops blocking the agent", () => {
    many(8, "opus", day(-3));
    const [c] = runModelReview(app, t0);
    expect(c!.state).toBe("asked");
    runModelReview(app, day(8));
    expect(getChange(app.db, c!.id)!.state).toBe("asked");
    expect(runModelReview(app, day(8))).toEqual([]);
    const next = runModelReview(app, day(15));
    const lapsed = getChange(app.db, c!.id)!;
    expect(lapsed.state).toBe("declined");
    expect(lapsed.result).toContain("nobody answered");
    expect(model()).toBe("opus");
    expect(events("crew.model_declined")[0]!.payload).toContain("expired");
    // the lapse and the next ask are a week and more apart, so the agent is free again
    expect(next).toHaveLength(1);
    expect(next[0]!.id).not.toBe(c!.id);
  });

  test("a failed event leaves neither a changed model nor a half-written trail", () => {
    many(8, "opus", day(-3));
    const [c] = runModelReview(app, t0);
    app.db.exec("CREATE TRIGGER no_event BEFORE INSERT ON event BEGIN SELECT RAISE(ABORT, 'no'); END");
    expect(() => decideChange(app, admin(), c!.id, true, day(1))).toThrow();
    expect(model()).toBe("opus");
    expect(getChange(app.db, c!.id)!.state).toBe("asked");
  });

  test("a step up always asks, even with the limit on", () => {
    setLimit(app.db, "model_review.auto", 1, agent.id);
    app.db.query("UPDATE agent SET model = 'sonnet' WHERE user_id = ?1").run(agent.id);
    many(8, "sonnet", day(-3), { reverted: true });
    const [c] = runModelReview(app, t0);
    expect(c).toMatchObject({ state: "asked", toModel: "opus" });
    expect(model()).toBe("sonnet");
  });

  test("the scorecard's doors carry the review, for an admin only", () => {
    expect(readScorecards(app, undefined)).toBeUndefined();
    expect(readScorecards(app, admin())?.modelReview.agents[0]?.username).toBe("torque");
  });
});

describe("the page", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-review-page-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
  });
  afterEach(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("Settings → Crew shows the review to an admin and refuses a stranger's button", async () => {
    const cookie = await adminCookie(app, { username: "ada", email: "ada@forge.example", password: "analytical-engine" });
    await fetch(`${servers.url}/api/v1/agents`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ username: "smith", model: "opus" }),
    });
    const page = await fetch(`${servers.url}/settings/crew`, { headers: { cookie } }).then((r) => r.text());
    expect(page).toContain("Model review");
    expect(page).toContain(`id="model-review-verdicts"`);
    const stranger = await fetch(`${servers.url}/settings/crew/model-review/nope/take`, { method: "POST", redirect: "manual" });
    expect(stranger.status).not.toBe(200);
  });

  describe("the button, through the server", () => {
    const opus: ModelStats = stats();
    let cookie = "";
    let agentId = "";

    async function asked(): Promise<string> {
      return recordChange(app.db, {
        agentId, fromModel: "opus", toModel: "sonnet", state: "asked", why: "cheaper and holds", before: opus, at: new Date(),
      });
    }
    const post = (path: string, headers: Record<string, string>) =>
      fetch(`${servers.url}${path}`, { method: "POST", redirect: "manual", headers });
    const modelNow = () => getAgent(app.db, agentId)!.model;

    beforeEach(async () => {
      cookie = await adminCookie(app, { username: "ada", email: "ada@forge.example", password: "analytical-engine" });
      const made = await fetch(`${servers.url}/api/v1/agents`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ username: "smith", model: "opus" }),
      }).then((r) => r.json() as Promise<{ id?: string; user?: { id: string } }>);
      agentId = made.user?.id ?? made.id ?? getUserByName(app.db, "smith")!.id;
    });

    test("an admin's same-origin POST to take moves the agent; the page then shows it on the trail", async () => {
      const id = await asked();
      const page = await fetch(`${servers.url}/settings/crew`, { headers: { cookie } }).then((r) => r.text());
      expect(page).toContain(`action="/settings/crew/model-review/${id}/take"`);
      const res = await post(`/settings/crew/model-review/${id}/take`, { cookie, origin: servers.url });
      expect(res.status).toBe(303);
      expect(modelNow()).toBe("sonnet");
      expect(getChange(app.db, id)!.state).toBe("applied");
    });

    test("an admin's POST to decline leaves the model", async () => {
      const id = await asked();
      const res = await post(`/settings/crew/model-review/${id}/decline`, { cookie, origin: servers.url });
      expect(res.status).toBe(303);
      expect(modelNow()).toBe("opus");
      expect(getChange(app.db, id)!.state).toBe("declined");
    });

    test("a cross-origin POST, an anonymous one and a non-admin's change nothing", async () => {
      const id = await asked();
      const cross = await post(`/settings/crew/model-review/${id}/take`, { cookie, origin: "https://evil.example" });
      expect(cross.status).toBe(403);
      const anon = await post(`/settings/crew/model-review/${id}/take`, { origin: servers.url });
      expect(anon.headers.get("location") ?? "").not.toContain("/settings/crew");
      const bob = await createUser(app.db, {
        origin: "seed", trusted: true, username: "bob", email: "bob@forge.example", password: "a-good-passphrase",
      });
      if (!bob.ok) throw new Error(bob.error);
      const bobCookie = `forge_session=${createSession(app.db, bob.value.id).token}`;
      for (const verb of ["take", "decline"]) {
        const res = await post(`/settings/crew/model-review/${id}/${verb}`, { cookie: bobCookie, origin: servers.url });
        expect(res.status).toBeGreaterThanOrEqual(300);
        expect(res.headers.get("location") ?? "").not.toBe("/settings/crew");
      }
      expect(modelNow()).toBe("opus");
      expect(getChange(app.db, id)!.state).toBe("asked");
    });
  });
});
