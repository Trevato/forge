/**
 * The weekly model review (#7815): from the ledger alone, how each crew
 * member fares on each model — cost per landed pull, red first checks, rework
 * rounds, reverts, and how hard the work was — and, from that, at most one
 * proposed change of model per member per week. Plain code, no model.
 *
 * A pull belongs to the model of its author's latest agent run on it (as the
 * scorecard's splits do). Its cost is every agent run on it, so a pull that
 * took three tries costs three. A pull is hard when a run on it escalated by
 * need (`p0`, `label:opus`), so a model is not judged on work it was not given.
 *
 * Pure data and SQL: no authz, no events (`actions/model_review.ts` has them).
 */
import type { Database } from "bun:sqlite";
import { id as newId } from "../kernel/id.ts";

/** Dearest first. A step down is one place to the right. */
export const LADDER: readonly string[] = ["claude-fable-5-1", "opus", "sonnet", "haiku"];
/** The window a review reads, and the days between reviews and before a result. */
export const REVIEW_DAYS = 28;
export const WEEK_MS = 7 * 86_400_000;
/** A result still too small to judge after this long is kept as it is. */
export const GIVE_UP_MS = 14 * 86_400_000;
/** A model is unhealthy at any revert, a rework round per landed pull, or half its checks red. */
const BAD_REWORK = 1;
const BAD_RED = 0.5;
/** More than this share of hard work and a cheaper model is not tried. */
const HARD_SHARE_MAX = 0.5;

export interface ModelStats {
  readonly model: string;
  readonly opened: number;
  readonly landed: number;
  /** Agent spend on the opened pulls ÷ landed; null before one lands. */
  readonly costPerLanded: number | null;
  /** Failed ÷ finished check runs; null with none. */
  readonly redRate: number | null;
  /** Changes-requested reviews per landed pull; null before one lands. */
  readonly reworkRounds: number | null;
  readonly reverts: number;
  /** Share of opened pulls that were hard; null with none opened. */
  readonly hardShare: number | null;
}

export interface Limits {
  /** Landed pulls a model needs in the window before it is judged. */
  readonly minLanded: number;
  /** Percentage points of red rate a cheaper model may be worse by. */
  readonly slackPct: number;
}

interface PullRow {
  author_id: string;
  model: string;
  landed: number;
  rounds: number;
  ok: number;
  failed: number;
  reverted: number;
  cost: number;
  hard: number;
}

/** Each author's stats per model over pulls opened in `[since, until)`. */
export function modelStats(
  db: Database,
  since: Date,
  until: Date = new Date("9999-12-31T00:00:00Z"),
): Map<string, ModelStats[]> {
  const rows = db
    .query<PullRow, [string, string]>(
      `SELECT issue.author_id AS author_id,
              COALESCE((SELECT run.model FROM run WHERE run.issue_id = issue.id
                         AND run.kind = 'agent' AND run.actor_id = issue.author_id
                         ORDER BY run.id DESC LIMIT 1), '') AS model,
              pull.merged_at IS NOT NULL AS landed,
              (SELECT COUNT(*) FROM review WHERE review.issue_id = issue.id
                 AND review.state = 'changes_requested') AS rounds,
              (SELECT COUNT(*) FROM run WHERE run.issue_id = issue.id
                 AND run.kind = 'check' AND run.state = 'ok') AS ok,
              (SELECT COUNT(*) FROM run WHERE run.issue_id = issue.id
                 AND run.kind = 'check' AND run.state = 'failed') AS failed,
              (pull.merged_at IS NOT NULL AND EXISTS (SELECT 1 FROM pull AS back
                 WHERE back.reverts_issue_id = issue.id AND back.merged_at IS NOT NULL)) AS reverted,
              COALESCE((SELECT SUM(run.cost_usd) FROM run WHERE run.issue_id = issue.id
                 AND run.kind = 'agent'), 0) AS cost,
              EXISTS (SELECT 1 FROM run WHERE run.issue_id = issue.id
                 AND run.kind = 'agent' AND run.model_reason IN ('p0', 'label:opus')) AS hard
         FROM issue
         JOIN pull ON pull.issue_id = issue.id
         JOIN user ON user.id = issue.author_id AND user.is_agent = 1
        WHERE issue.created_at >= ?1 AND issue.created_at < ?2`,
    )
    .all(since.toISOString(), until.toISOString());
  const groups = new Map<string, PullRow[]>();
  for (const r of rows) {
    const key = `${r.author_id}\0${r.model}`;
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [r]);
    else list.push(r);
  }
  const out = new Map<string, ModelStats[]>();
  for (const list of groups.values()) {
    const first = list[0];
    if (first === undefined) continue;
    const sum = (f: (r: PullRow) => number) => list.reduce((n, r) => n + f(r), 0);
    const landed = sum((r) => r.landed);
    const checks = sum((r) => r.ok) + sum((r) => r.failed);
    const stats: ModelStats = {
      model: first.model,
      opened: list.length,
      landed,
      costPerLanded: landed === 0 ? null : sum((r) => r.cost) / landed,
      redRate: checks === 0 ? null : sum((r) => r.failed) / checks,
      reworkRounds:
        landed === 0 ? null : sum((r) => (r.landed === 1 ? r.rounds : 0)) / landed,
      reverts: sum((r) => r.reverted),
      hardShare: sum((r) => r.hard) / list.length,
    };
    const mine = out.get(first.author_id) ?? [];
    mine.push(stats);
    out.set(first.author_id, mine);
  }
  for (const list of out.values()) list.sort((a, b) => b.opened - a.opened);
  return out;
}

export type Verdict =
  | { readonly kind: "hold"; readonly note: string }
  | {
      readonly kind: "propose";
      readonly to: string;
      readonly direction: "down" | "up";
      readonly why: string;
    };

const pct = (n: number | null) => (n === null ? "no checks" : `${Math.round(100 * n)}% red`);
const usd = (n: number | null) => (n === null ? "—" : `$${n.toFixed(2)}`);

/** Whether a model's own numbers are poor enough that a dearer one is worth asking for. */
export function unhealthy(s: ModelStats): boolean {
  return s.reverts > 0 || (s.reworkRounds ?? 0) >= BAD_REWORK || (s.redRate ?? 0) >= BAD_RED;
}

/** Pure: one member's model and numbers in, at most one change out; a small sample changes nothing. */
export function review(current: string, stats: readonly ModelStats[], limits: Limits): Verdict {
  const at = LADDER.indexOf(current.toLowerCase());
  if (at < 0) return { kind: "hold", note: current === "" ? "runs on the runner's default; name a model to review it" : `${current} is not on the review ladder` };
  const mine = stats.find((s) => s.model.toLowerCase() === current.toLowerCase());
  if (mine === undefined || mine.landed < limits.minLanded)
    return {
      kind: "hold",
      note: `${mine?.landed ?? 0} landed on ${current} in ${REVIEW_DAYS} days; ${limits.minLanded} are needed to judge, so nothing changes`,
    };
  const line = `${mine.landed} landed at ${usd(mine.costPerLanded)} each, ${pct(mine.redRate)}, ${(mine.reworkRounds ?? 0).toFixed(1)} rework rounds, ${mine.reverts} reverted`;
  if (unhealthy(mine)) {
    const to = LADDER[at - 1];
    if (to === undefined) return { kind: "hold", note: `${line}: poor, and already on the top model` };
    return { kind: "propose", to, direction: "up", why: `${current} is not holding its quality (${line})` };
  }
  const to = LADDER[at + 1];
  if (to === undefined) return { kind: "hold", note: `${line}: already on the cheapest model` };
  if ((mine.hardShare ?? 0) > HARD_SHARE_MAX)
    return { kind: "hold", note: `${line}: over half of it was hard work, so a cheaper model is not tried` };
  const there = stats.find((s) => s.model.toLowerCase() === to);
  if (there !== undefined && there.landed >= limits.minLanded) {
    const worse =
      there.reverts > mine.reverts ||
      (there.redRate ?? 0) > (mine.redRate ?? 0) + limits.slackPct / 100 ||
      (there.reworkRounds ?? 0) > (mine.reworkRounds ?? 0) + 0.5;
    const dearer = (there.costPerLanded ?? 0) >= (mine.costPerLanded ?? 0);
    if (worse || dearer)
      return { kind: "hold", note: `${line}; on ${to} it did ${there.landed} at ${usd(there.costPerLanded)} each, ${pct(there.redRate)}: no better, so it stays` };
    return { kind: "propose", to, direction: "down", why: `${current} holds (${line}) and ${to} did as well on ${there.landed} landed at ${usd(there.costPerLanded)} each` };
  }
  return { kind: "propose", to, direction: "down", why: `${current} holds (${line}); ${to} has no numbers yet, so this is a one-week trial` };
}

/** Whether `after` fell short of `before` by more than the slack allows. */
export function fellShort(before: ModelStats, after: ModelStats, limits: Limits): boolean {
  return (
    after.reverts > before.reverts ||
    (after.redRate ?? 0) > (before.redRate ?? 0) + limits.slackPct / 100 ||
    (after.reworkRounds ?? 0) > (before.reworkRounds ?? 0) + 0.5
  );
}

// ---- the trail ----

export type ReviewState = "asked" | "applied" | "declined" | "kept" | "undone";

export interface ModelChange {
  readonly id: string;
  readonly agentId: string;
  readonly fromModel: string;
  readonly toModel: string;
  readonly state: ReviewState;
  readonly why: string;
  readonly before: ModelStats;
  readonly after: ModelStats | null;
  readonly result: string;
  readonly createdAt: string;
  readonly decidedBy: string | null;
  readonly appliedAt: string | null;
  readonly settledAt: string | null;
}

interface ChangeRow {
  id: string;
  agent_id: string;
  from_model: string;
  to_model: string;
  state: ReviewState;
  why: string;
  before_json: string;
  after_json: string | null;
  result: string;
  created_at: string;
  decided_by: string | null;
  applied_at: string | null;
  settled_at: string | null;
}

const toChange = (r: ChangeRow): ModelChange => ({
  id: r.id,
  agentId: r.agent_id,
  fromModel: r.from_model,
  toModel: r.to_model,
  state: r.state,
  why: r.why,
  before: JSON.parse(r.before_json) as ModelStats,
  after: r.after_json === null ? null : (JSON.parse(r.after_json) as ModelStats),
  result: r.result,
  createdAt: r.created_at,
  decidedBy: r.decided_by,
  appliedAt: r.applied_at,
  settledAt: r.settled_at,
});

/** Newest first; one agent's, or everyone's. */
export function listChanges(db: Database, agentId?: string, limit = 50): ModelChange[] {
  return db
    .query<ChangeRow, [string | null, number]>(
      `SELECT * FROM model_review WHERE ?1 IS NULL OR agent_id = ?1
        ORDER BY created_at DESC, id DESC LIMIT ?2`,
    )
    .all(agentId ?? null, limit)
    .map(toChange);
}

export function getChange(db: Database, changeId: string): ModelChange | undefined {
  const row = db
    .query<ChangeRow, [string]>("SELECT * FROM model_review WHERE id = ?1")
    .get(changeId);
  return row === null ? undefined : toChange(row);
}

export function recordChange(
  db: Database,
  c: {
    agentId: string;
    fromModel: string;
    toModel: string;
    state: "asked" | "applied";
    why: string;
    before: ModelStats;
    at: Date;
  },
): string {
  const id = newId();
  const at = c.at.toISOString();
  db.query(
    `INSERT INTO model_review (id, agent_id, from_model, to_model, state, why, before_json, created_at, applied_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  ).run(id, c.agentId, c.fromModel, c.toModel, c.state, c.why, JSON.stringify(c.before), at, c.state === "applied" ? at : null);
  return id;
}

export function setState(
  db: Database,
  changeId: string,
  patch: { state: ReviewState; decidedBy?: string; appliedAt?: Date; settledAt?: Date; after?: ModelStats; result?: string },
): void {
  db.query(
    `UPDATE model_review SET state = ?2, decided_by = COALESCE(?3, decided_by),
            applied_at = COALESCE(?4, applied_at), settled_at = COALESCE(?5, settled_at),
            after_json = COALESCE(?6, after_json), result = COALESCE(?7, result)
      WHERE id = ?1`,
  ).run(
    changeId,
    patch.state,
    patch.decidedBy ?? null,
    patch.appliedAt?.toISOString() ?? null,
    patch.settledAt?.toISOString() ?? null,
    patch.after === undefined ? null : JSON.stringify(patch.after),
    patch.result ?? null,
  );
}

/** Whether a member has a change in the last week (made or just settled), or one waiting on a person or on its result. */
export function busy(db: Database, agentId: string, now: Date): boolean {
  const since = new Date(now.getTime() - WEEK_MS).toISOString();
  return (
    db
      .query(
        `SELECT 1 FROM model_review WHERE agent_id = ?1 AND state != 'declined'
            AND (created_at >= ?2 OR settled_at >= ?2 OR state = 'asked' OR (state = 'applied' AND settled_at IS NULL))`,
      )
      .get(agentId, since) !== null
  );
}

export function lastRun(db: Database): Date | undefined {
  const row = db.query<{ at: string | null }, []>("SELECT MAX(at) AS at FROM model_review_run").get();
  return row?.at == null ? undefined : new Date(row.at);
}

export function markRun(db: Database, at: Date): void {
  db.query("INSERT INTO model_review_run (at) VALUES (?1)").run(at.toISOString());
}
