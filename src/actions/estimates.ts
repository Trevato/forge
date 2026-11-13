/**
 * The `estimate` act (#11955), one tool for two uses: ask the base rate for an
 * issue, or record an estimate against it. The page, the API, MCP and the
 * terminal call these and say the same words. Validation is here, at the
 * boundary; rows and maths are `core/estimates.ts` and `flow/estimate_*`.
 */
import type { App } from "../app.ts";
import { addEstimate, currentOf, estimatesOf, estimatesVisibleTo, isEvent, type EstimateEvent, type EstimateRow } from "../core/estimates.ts";
import { forgeSource } from "../settings/forge_source.ts";
import { getIssue, type Issue } from "../core/issues.ts";
import { mergedPullClosing, openPullsClosing } from "../core/pulls.ts";
import { nextUp } from "../core/next_up.ts";
import { canWrite, type Repo } from "../core/repos.ts";
import { listActiveRuns } from "../core/runs.ts";
import type { User } from "../core/users.ts";
import { budgetLines } from "../crew/forge_budget.ts";
import { baseRate, historySamples, type BaseRate } from "../flow/estimate_base.ts";
import { kindOf, labelsOf, sizeOf } from "../flow/estimate.ts";
import { lastLine } from "../flow/estimate_score.ts";
import { estimateLine } from "../flow/estimate_words.ts";
import { blocking, standingHolds } from "../keeper/hold.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export const ESTIMATE_FORBIDDEN = "Only someone with write access, or a crew member on this repository, records an estimate.";
export const ESTIMATE_NOT_OPEN = "Only an open issue is estimated.";
export const ESTIMATE_SHAPE =
  "`event` is pull_opened, merged or live; `p50` and `p90` are instants like 2026-11-14T07:15:00Z, both in the future with p50 no later than p90; `basis` is one line, at most 300 characters.";
export const ESTIMATE_PASSED = "That event has already happened, so it is not estimated.";
const BASIS_MAX = 300;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export type EstimateError = { kind: "not_found" | "forbidden" | "invalid"; message: string };

/** What is true now that history does not know. */
export interface NowFacts {
  /** Place on /next, 1 at the top; null when the issue is not on the list. */
  readonly queuePosition: number | null;
  readonly listed: number;
  /** Agent runs going on this repository now. */
  readonly buildersBusy: number;
  /** USD left of the forge's day and month budgets. */
  readonly budgetLeftUsd: { readonly day: number; readonly month: number };
  /** Why the keeper will not cut a release now; null when nothing holds one. */
  readonly releasesHeld: string | null;
}

export interface Asked {
  readonly repo: string;
  readonly number: number;
  readonly size: string;
  readonly kind: string;
  readonly now: string;
  readonly base: BaseRate;
  readonly facts: NowFacts;
  readonly current: readonly EstimateRow[];
  readonly scorecard: string;
  readonly line: string | undefined;
}

function startedAt(app: App, issue: Issue): number | undefined {
  const row = app.db
    .query<{ at: string | null }, [string]>("SELECT MIN(created_at) AS at FROM run WHERE issue_id = ?1 AND kind = 'agent'")
    .get(issue.id);
  const ms = row?.at == null ? NaN : Date.parse(row.at);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * The base rate for this issue at `now`: one read of the history, the same answer for the same
 * history.
 */
export function baseFor(app: App, repo: Repo, issue: Issue, now: Date): BaseRate {
  const labels = labelsOf(app.db, [issue.id]).get(issue.id) ?? [];
  const started = startedAt(app, issue);
  const samples = historySamples(app.db, repo.id, now.getTime() - 90 * 86_400_000, now.getTime());
  return baseRate(
    samples,
    { size: sizeOf(issue), kind: kindOf(labels), builder: issue.assigneeName ?? null, elapsedMs: started === undefined ? 0 : Math.max(0, now.getTime() - started) },
    `${repo.ownerName}/${repo.name}`,
    now.getTime(),
  );
}

function factsOf(app: App, repo: Repo, issue: Issue, now: Date): NowFacts {
  const rows = nextUp(app.db, repo).rows;
  const at = rows.findIndex((r) => r.issue.id === issue.id);
  const [, day, month] = budgetLines(app.db, now);
  const own = forgeSource(app.db, app.config.forgeRepo);
  const forge = own !== undefined && own.toLowerCase() === `${repo.ownerName}/${repo.name}`.toLowerCase();
  return {
    queuePosition: at < 0 ? null : at + 1,
    listed: rows.length,
    buildersBusy: listActiveRuns(app.db, [repo.id]).length,
    budgetLeftUsd: {
      day: Math.max(0, Math.round((day!.limitUsd - (day!.spentUsd ?? 0)) * 100) / 100),
      month: Math.max(0, Math.round((month!.limitUsd - (month!.spentUsd ?? 0)) * 100) / 100),
    },
    releasesHeld: forge ? blocking(standingHolds(app.db)) ?? null : null,
  };
}

/**
 * The issue as the act sees it: an issue, not a pull. Whether it is open is `recordEstimate`'s
 * say; asking is for any issue the caller may see.
 */
export function estimateIssue(app: App, repo: Repo, number: number): Issue | undefined {
  const issue = Number.isInteger(number) && number > 0 ? getIssue(app.db, repo.id, number) : undefined;
  return issue !== undefined && issue.kind === "issue" ? issue : undefined;
}

/** Ask: the base rate for this issue and what is true now, with the asker's own scorecard. */
export function askEstimate(app: App, actor: User | undefined, repo: Repo, issue: Issue, now: Date = new Date()): Asked {
  const rows = estimatesOf(app.db, issue.id);
  const labels = labelsOf(app.db, [issue.id]).get(issue.id) ?? [];
  return {
    repo: `${repo.ownerName}/${repo.name}`,
    number: issue.number,
    size: sizeOf(issue),
    kind: kindOf(labels),
    now: now.toISOString(),
    base: baseFor(app, repo, issue, now),
    facts: factsOf(app, repo, issue, now),
    current: currentOf(rows),
    scorecard: actor === undefined ? "" : lastLine(estimatesVisibleTo(app.db, actor, actor.id), actor.username, true),
    line: estimateLine(currentOf(rows), now.getTime()),
  };
}

export interface EstimateInput {
  readonly event?: unknown;
  readonly p50?: unknown;
  readonly p90?: unknown;
  readonly basis?: unknown;
}

const instant = (v: unknown): number | undefined => {
  if (typeof v !== "string" || !INSTANT.test(v)) return undefined;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : undefined;
};

/**
 * Record: validated, stamped with who and when, and the base rate shown at that moment. A new one
 * supersedes; the old rows stay.
 */
export function recordEstimate(
  app: App,
  actor: User,
  repo: Repo,
  issue: Issue,
  input: EstimateInput,
  now: Date = new Date(),
): Result<{ estimate: EstimateRow; base: BaseRate; scorecard: string }, EstimateError> {
  const invalid = (message: string) => err<EstimateError>({ kind: "invalid", message });
  if (!canWrite(app.db, repo, actor)) return err({ kind: "forbidden", message: ESTIMATE_FORBIDDEN });
  if (issue.state !== "open") return invalid(ESTIMATE_NOT_OPEN);
  if (!isEvent(input.event)) return invalid(ESTIMATE_SHAPE);
  const event: EstimateEvent = input.event;
  const p50 = instant(input.p50);
  const p90 = instant(input.p90);
  if (p50 === undefined || p90 === undefined) return invalid(ESTIMATE_SHAPE);
  if (p50 <= now.getTime() || p90 <= now.getTime()) return invalid("Both times are in the future: " + ESTIMATE_SHAPE);
  if (p50 > p90) return invalid("p50 is no later than p90.");
  const basis = input.basis === undefined ? "" : input.basis;
  // eslint-disable-next-line no-control-regex
  if (typeof basis !== "string" || basis.length > BASIS_MAX || /[\u0000-\u001f\u007f]/.test(basis)) return invalid(ESTIMATE_SHAPE);
  const happened =
    event === "pull_opened"
      ? openPullsClosing(app.db, repo.id).has(issue.number) || mergedPullClosing(app.db, repo.id, issue.number) !== undefined
      : event === "merged"
        ? mergedPullClosing(app.db, repo.id, issue.number) !== undefined
        : false;
  if (happened) return invalid(ESTIMATE_PASSED);
  const base = baseFor(app, repo, issue, now);
  const labels = labelsOf(app.db, [issue.id]).get(issue.id) ?? [];
  const id = addEstimate(app.db, {
    repoId: repo.id,
    issueId: issue.id,
    event,
    p50At: new Date(p50).toISOString(),
    p90At: new Date(p90).toISOString(),
    madeAt: now.toISOString(),
    byId: actor.id,
    byKind: actor.kind === "agent" ? "agent" : "person",
    basis: basis.trim(),
    baseJson: JSON.stringify(base),
    size: sizeOf(issue),
    kind: kindOf(labels),
  });
  app.bus.append({
    kind: "issue.estimated",
    repoId: repo.id,
    actorId: actor.id,
    payload: { number: issue.number, event, estimate: id },
  });
  const estimate = estimatesOf(app.db, issue.id).find((e) => e.id === id)!;
  return ok({ estimate, base, scorecard: lastLine(estimatesVisibleTo(app.db, actor, actor.id), actor.username, true) });
}
