/**
 * The weekly model review, as actions (#7815): the tick the forge runs, the
 * owner's one button, and the read for the scorecard's doors. Every change
 * is an event on the outbox with its before numbers, and its result a week
 * later; a cheaper model that did not hold is undone.
 */
import type { App } from "../app.ts";
import { getAgent, listAgents, updateAgent as patchAgent } from "../core/agents.ts";
import {
  busy,
  fellShort,
  getChange,
  GIVE_UP_MS,
  lastRun,
  listChanges,
  markRun,
  modelStats,
  recordChange,
  review,
  REVIEW_DAYS,
  setState,
  WEEK_MS,
  type Limits,
  type ModelChange,
  type ModelStats,
  type Verdict,
} from "../core/model_review.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { limitValue } from "../settings/limits.ts";

export function reviewLimits(app: App): Limits & { auto: boolean } {
  return {
    minLanded: limitValue(app.db, "model_review.min_landed"),
    slackPct: limitValue(app.db, "model_review.slack_pct"),
    auto: limitValue(app.db, "model_review.auto") === 1,
  };
}

const pctOf = (n: number | null) => (n === null ? "no checks" : `${Math.round(100 * n)}% red`);
const usd = (n: number | null) => (n === null ? "—" : `$${n.toFixed(2)}`);
const figures = (s: ModelStats) =>
  `${s.landed} landed at ${usd(s.costPerLanded)} each, ${pctOf(s.redRate)}, ${(s.reworkRounds ?? 0).toFixed(1)} rework rounds, ${s.reverts} reverted`;

const empty = (model: string): ModelStats => ({
  model, opened: 0, landed: 0, costPerLanded: null, redRate: null, reworkRounds: null, reverts: 0, hardShare: null,
});

/** What the review says now for each member, without changing anything. */
export function readReview(app: App, now = new Date()) {
  const limits = reviewLimits(app);
  const stats = modelStats(app.db, new Date(now.getTime() - REVIEW_DAYS * 86_400_000));
  return {
    windowDays: REVIEW_DAYS,
    limits,
    agents: listAgents(app.db).map((agent) => {
      const mine = stats.get(agent.user.id) ?? [];
      const verdict: Verdict = review(agent.model, mine, limits);
      return { username: agent.user.username, model: agent.model, models: mine, verdict };
    }),
    changes: listChanges(app.db),
  };
}

/** The model, the review row and the event move together, or not at all. */
function apply(app: App, change: ModelChange, by: User | undefined, now: Date, how: string): void {
  app.db.transaction(() => {
    patchAgent(app.db, change.agentId, { model: change.toModel });
    setState(app.db, change.id, { state: "applied", appliedAt: now, ...(by === undefined ? {} : { decidedBy: by.id }) });
    app.bus.append({
      kind: "crew.model_changed",
      ...(by === undefined ? {} : { actorId: by.id }),
      payload: { agent: nameOf(app, change.agentId), from: change.fromModel, to: change.toModel, how, why: change.why, before: change.before },
    });
  })();
}

const nameOf = (app: App, agentId: string) => getAgent(app.db, agentId)?.user.username ?? agentId;

/** The owner's one button on a change that asked: take it, or leave it. */
export function decideChange(
  app: App,
  actor: User | undefined,
  changeId: string,
  take: boolean,
  now = new Date(),
): Result<ModelChange, "not_found"> {
  if (actor?.isAdmin !== true || actor.kind !== "user") return err("not_found");
  const change = getChange(app.db, changeId);
  if (change === undefined || change.state !== "asked") return err("not_found");
  if (take) apply(app, change, actor, now, "owner");
  else {
    app.db.transaction(() => {
      setState(app.db, change.id, { state: "declined", decidedBy: actor.id, settledAt: now });
      app.bus.append({
        kind: "crew.model_declined",
        actorId: actor.id,
        payload: { agent: nameOf(app, change.agentId), from: change.fromModel, to: change.toModel },
      });
    })();
  }
  return ok(getChange(app.db, changeId) ?? change);
}

/** A week on, say how a change went and undo it if quality fell. */
export function settleChanges(app: App, now = new Date()): void {
  const limits = reviewLimits(app);
  for (const change of listChanges(app.db, undefined, 500)) {
    if (change.state === "asked") {
      // One ignored ask must not block the agent for ever: after two weeks it lapses as declined.
      if (now.getTime() - new Date(change.createdAt).getTime() < GIVE_UP_MS) continue;
      app.db.transaction(() => {
        setState(app.db, change.id, { state: "declined", settledAt: now, result: "nobody answered in two weeks; left as it was" });
        app.bus.append({
          kind: "crew.model_declined",
          payload: { agent: nameOf(app, change.agentId), from: change.fromModel, to: change.toModel, expired: true },
        });
      })();
      continue;
    }
    if (change.state !== "applied" || change.settledAt !== null || change.appliedAt === null) continue;
    const since = new Date(change.appliedAt);
    const age = now.getTime() - since.getTime();
    if (age < WEEK_MS) continue;
    const agent = getAgent(app.db, change.agentId);
    if (agent === undefined) continue;
    const after =
      modelStats(app.db, since).get(change.agentId)?.find((s) => s.model.toLowerCase() === change.toModel.toLowerCase()) ??
      empty(change.toModel);
    const name = agent.user.username;
    const finish = (state: "kept" | "undone", result: string) => {
      app.db.transaction(() => {
        if (state === "undone") patchAgent(app.db, change.agentId, { model: change.fromModel });
        setState(app.db, change.id, { state, settledAt: now, after, result });
        app.bus.append({
          kind: "crew.model_result",
          payload: { agent: name, from: change.fromModel, to: change.toModel, state, result, before: change.before, after },
        });
      })();
    };
    if (agent.model.toLowerCase() !== change.toModel.toLowerCase()) {
      finish("kept", `the model was changed by hand since, so nothing was undone`);
    } else if (after.landed < limits.minLanded) {
      if (age >= GIVE_UP_MS) finish("kept", `only ${after.landed} landed on ${change.toModel} in two weeks, too few to judge; kept`);
    } else if (fellShort(change.before, after, limits)) {
      finish("undone", `quality fell on ${change.toModel} (${figures(after)}; before ${figures(change.before)}); back to ${change.fromModel}`);
    } else {
      finish("kept", `held on ${change.toModel} (${figures(after)}; before ${figures(change.before)})`);
    }
  }
}

/**
 * The tick: settle what is a week old, then, once a week, review each
 * member. Safe to call as often as you like. Returns the changes it made or
 * asked for.
 */
export function runModelReview(app: App, now = new Date()): ModelChange[] {
  settleChanges(app, now);
  const ran = lastRun(app.db);
  if (ran !== undefined && now.getTime() - ran.getTime() < WEEK_MS) return [];
  markRun(app.db, now);
  const limits = reviewLimits(app);
  const made: ModelChange[] = [];
  const stats = modelStats(app.db, new Date(now.getTime() - REVIEW_DAYS * 86_400_000));
  for (const agent of listAgents(app.db)) {
    if (busy(app.db, agent.user.id, now)) continue;
    const mine = stats.get(agent.user.id) ?? [];
    const verdict = review(agent.model, mine, limits);
    if (verdict.kind !== "propose") continue;
    const before = mine.find((s) => s.model.toLowerCase() === agent.model.toLowerCase());
    if (before === undefined) continue;
    const auto = limits.auto && verdict.direction === "down";
    const change = app.db.transaction((): ModelChange | undefined => {
      const changeId = recordChange(app.db, {
        agentId: agent.user.id, fromModel: agent.model, toModel: verdict.to,
        state: "asked", why: verdict.why, before, at: now,
      });
      const made = getChange(app.db, changeId);
      if (made === undefined) return undefined;
      if (auto) apply(app, made, undefined, now, "review");
      else {
        app.bus.append({
          kind: "crew.model_asked",
          payload: { agent: agent.user.username, from: made.fromModel, to: made.toModel, why: made.why, before },
        });
      }
      return getChange(app.db, changeId);
    })();
    if (change === undefined) continue;
    made.push(change);
  }
  return made;
}
