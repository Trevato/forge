/**
 * The base rate for an issue (#11955): how long past issues like it took from the
 * start of work to each event, from the forge's own history. Measured, never
 * guessed; the same history gives the same answer. Plain data in and out;
 * `historySamples` is the one read.
 *
 * Start of work is the first agent run on the issue, else its creation. Time
 * waiting in the queue is therefore not in the rates: it is said beside them
 * (`flow/estimate_now.ts`). Quantiles are nearest-rank over the sorted
 * durations, `sorted[round((n - 1) * q)]`, so a test can do it by hand.
 */
import type { Database } from "bun:sqlite";
import type { EstimateEvent } from "../core/estimates.ts";
import { closesFromBody } from "../core/pulls.ts";
import { kindOf, labelsOf, sizeOf, type Size } from "./estimate.ts";
import { durationWords } from "./estimate_words.ts";

/** Samples a group needs before it speaks plainly. */
export const MIN_BASE = 5;
const DAY = 86_400_000;
/** The most merged pulls one read walks. */
const PULLS_MAX = 600;

export interface HistorySample {
  readonly number: number;
  readonly size: Size;
  readonly kind: string;
  readonly builder: string | null;
  /**
   * Milliseconds from the start of work to each event; live is absent when no release since the
   * merge has served.
   */
  readonly pull: number;
  readonly merged: number;
  readonly live: number | undefined;
  readonly mergedAtMs: number;
  /** Start of work to the close (never before the merge); absent in old samples. */
  readonly done?: number;
  /** Closed once and opened again: the work was not finished when it was called finished. */
  readonly reopened?: boolean;
  /**
   * Not closed now, because it was reopened: counts toward the reopen rate, not toward a
   * duration.
   */
  readonly open?: boolean;
}

export interface EventRate {
  readonly n: number;
  /** From now, in ms. */
  readonly p50Ms: number;
  readonly p90Ms: number;
  readonly p50At: string;
  readonly p90At: string;
}

export interface BaseRate {
  readonly n: number;
  /** True when fewer than {@link MIN_BASE} samples were found even after widening. */
  readonly thin: boolean;
  /** What was widened, in order, e.g. ["dropped the builder", "dropped the kind"]. */
  readonly widened: readonly string[];
  readonly basis: string;
  readonly events: Record<EstimateEvent, EventRate | null>;
  /**
   * Of the issues like these that a pull closed, how many were reopened after: the cost of
   * "merged is not works".
   */
  readonly reopened: { readonly n: number; readonly of: number };
}

/** Nearest-rank quantile of an ascending array. */
export const quantile = (sorted: readonly number[], q: number): number => sorted[Math.round((sorted.length - 1) * q)]!;
const ascending = (xs: readonly number[]): number[] => [...xs].sort((a, b) => a - b);

/**
 * Past issues finished in the window: merged pulls that closed them, with when work started and
 * when each release went live.
 */
export function historySamples(db: Database, repoId: string, sinceMs: number, nowMs: number): HistorySample[] {
  const since = new Date(sinceMs).toISOString();
  const pulls = db
    .query<{ body: string; opened: string; merged: string }, [string, string, number]>(
      `SELECT i.body, i.created_at AS opened, p.merged_at AS merged FROM pull p JOIN issue i ON i.id = p.issue_id
        WHERE i.repo_id = ?1 AND p.merged_at IS NOT NULL AND p.merged_at >= ?2 ORDER BY p.merged_at DESC LIMIT ?3`,
    )
    .all(repoId, since, PULLS_MAX);
  const closed = new Map<number, { opened: string; merged: string }>();
  for (const p of pulls) for (const n of closesFromBody(p.body)) if (!closed.has(n)) closed.set(n, p);
  if (closed.size === 0) return [];
  const numbers = JSON.stringify([...closed.keys()].slice(0, PULLS_MAX * 4));
  const issues = db
    .query<{ id: string; number: number; title: string; body: string; created_at: string; assignee: string | null; started: string | null; state: string; close_reason: string | null; closed_at: string | null }, [string, string]>(
      `SELECT i.id, i.number, i.title, i.body, i.created_at, a.username AS assignee, i.state, i.close_reason, i.closed_at,
              (SELECT MIN(r.created_at) FROM run r WHERE r.issue_id = i.id AND r.kind = 'agent') AS started
         FROM issue i LEFT JOIN user a ON a.id = i.assignee_id
        WHERE i.repo_id = ?1 AND i.kind = 'issue'
          AND i.number IN (SELECT value FROM json_each(?2))`,
    )
    .all(repoId, numbers)
    .filter((i) => closed.has(i.number));
  const reopened = new Set(
    db
      .query<{ n: number | null }, [string, string]>(
        `SELECT DISTINCT json_extract(payload, '$.number') AS n FROM event WHERE repo_id = ?1 AND kind = 'issue.reopened' AND created_at >= ?2`,
      )
      .all(repoId, since)
      .flatMap((r) => (r.n === null ? [] : [r.n])),
  );
  const labels = labelsOf(db, issues.map((i) => i.id));
  const releases = db
    .query<{ cut_at: string; live_at: string }, [string]>(
      `SELECT cut_at, live_at FROM keeper_release WHERE live_at IS NOT NULL AND stage != 'rolled_back' AND cut_at >= ?1 ORDER BY cut_at`,
    )
    .all(since);
  const out: HistorySample[] = [];
  for (const i of issues) {
    const wasReopened = reopened.has(i.number);
    const finished = i.state === "closed" && i.close_reason === "done";
    // An issue that is open again is no duration, but it is a reopen; any other open one is
    // neither.
    if (!finished && !wasReopened) continue;
    const c = closed.get(i.number)!;
    const start = Date.parse(i.started ?? i.created_at);
    const merged = Date.parse(c.merged);
    const opened = Date.parse(c.opened);
    if (![start, merged, opened].every(Number.isFinite) || merged < start || merged > nowMs) continue;
    const release = releases.find((r) => r.cut_at >= c.merged);
    const live = release === undefined ? undefined : Date.parse(release.live_at);
    out.push({
      number: i.number,
      size: sizeOf(i),
      kind: kindOf(labels.get(i.id) ?? []),
      builder: i.assignee,
      pull: Math.max(0, Math.min(opened, merged) - start),
      merged: merged - start,
      live: live === undefined || !Number.isFinite(live) || live < merged ? undefined : live - start,
      mergedAtMs: merged,
      ...(finished && i.closed_at !== null && Number.isFinite(Date.parse(i.closed_at)) ? { done: Math.max(merged, Date.parse(i.closed_at)) - start } : {}),
      reopened: wasReopened,
      open: !finished,
    });
  }
  return out;
}

export interface Target {
  readonly size: Size;
  readonly kind: string;
  readonly builder: string | null;
  /** Milliseconds since work started on it; 0 when it has not. */
  readonly elapsedMs: number;
}

/**
 * From now: those still running at `elapsed` count what is left; if fewer than {@link MIN_BASE}
 * still run, all count in full.
 */
function fromNow(durations: readonly number[], elapsedMs: number, nowMs: number): EventRate | null {
  if (durations.length === 0) return null;
  const running = durations.filter((d) => d > elapsedMs).map((d) => d - elapsedMs);
  const left = ascending(elapsedMs > 0 && running.length >= MIN_BASE ? running : durations);
  const p50Ms = quantile(left, 0.5);
  const p90Ms = quantile(left, 0.9);
  return { n: durations.length, p50Ms, p90Ms, p50At: new Date(nowMs + p50Ms).toISOString(), p90At: new Date(nowMs + p90Ms).toISOString() };
}

/**
 * The base rate of `target` among `samples` (all within 90 days), widening until {@link MIN_BASE}
 * are found.
 */
export function baseRate(allSamples: readonly HistorySample[], target: Target, where: string, nowMs: number): BaseRate {
  const samples = allSamples.filter((s) => s.open !== true);
  const inDays = (days: number) => samples.filter((s) => s.mergedAtMs >= nowMs - days * DAY);
  const bySize = (s: HistorySample) => s.size === target.size;
  const byKind = (s: HistorySample) => bySize(s) && s.kind === target.kind;
  const byBuilder = (s: HistorySample) => byKind(s) && s.builder === target.builder;
  const levels: { widen: string | null; pick: () => HistorySample[]; who: string; match: (s: HistorySample) => boolean; days: number }[] = [
    ...(target.builder === null
      ? []
      : [{ widen: null, who: `${target.size} ${target.kind === "" ? "" : `${target.kind} `}issues by ${target.builder}, last 30 days`, pick: () => inDays(30).filter(byBuilder), match: byBuilder, days: 30 }]),
    { widen: target.builder === null ? null : "dropped the builder", who: `${target.size} ${target.kind === "" ? "" : `${target.kind} `}issues, last 30 days`, pick: () => inDays(30).filter(byKind), match: byKind, days: 30 },
    { widen: "dropped the kind", who: `${target.size} issues, last 30 days`, pick: () => inDays(30).filter(bySize), match: bySize, days: 30 },
    { widen: "dropped the size", who: "issues of any size, last 30 days", pick: () => inDays(30), match: () => true, days: 30 },
    { widen: "widened to 90 days", who: "issues of any size, last 90 days", pick: () => inDays(90), match: () => true, days: 90 },
  ];
  const widened: string[] = [];
  let used = levels[levels.length - 1]!;
  let group: HistorySample[] = [];
  for (const level of levels) {
    if (level.widen !== null) widened.push(level.widen);
    group = level.pick();
    used = level;
    if (group.length >= MIN_BASE) break;
  }
  // The same group, plus the issues a pull closed that were reopened and are open again.
  const reads = allSamples.filter((s) => used.match(s) && s.mergedAtMs >= nowMs - used.days * DAY);
  const reopenedOf = { n: reads.filter((s) => s.reopened === true).length, of: reads.length };
  const thin = group.length < MIN_BASE;
  const events: Record<EstimateEvent, EventRate | null> = {
    pull_opened: fromNow(group.map((s) => s.pull), target.elapsedMs, nowMs),
    merged: fromNow(group.map((s) => s.merged), target.elapsedMs, nowMs),
    live: fromNow(group.flatMap((s) => (s.live === undefined ? [] : [s.live])), target.elapsedMs, nowMs),
    done: fromNow(group.flatMap((s) => (s.done === undefined ? [] : [s.done])), target.elapsedMs, nowMs),
  };
  const merged = events.merged;
  const live = events.live;
  const stage = group.flatMap((s) => (s.live === undefined ? [] : [s.live - s.merged])).sort((a, b) => a - b);
  const parts = [
    merged === null ? "nothing merged yet" : `${target.elapsedMs > 0 ? "now→merged" : "work start→merged"} p50 ${durationWords(merged.p50Ms)}, p90 ${durationWords(merged.p90Ms)}`,
    stage.length === 0 || live === null ? "no release has gone live since" : `merged→live p50 ${durationWords(quantile(stage, 0.5))}, p90 ${durationWords(quantile(stage, 0.9))}`,
    reopenedOf.of === 0 ? "reopened: no history" : `reopened after closing: ${reopenedOf.n} of ${reopenedOf.of}`,
  ];
  const basis = thin
    ? `only ${group.length} ${used.who} in ${where} (fewer than ${MIN_BASE}; ${widened.length === 0 ? "nothing wider to try" : widened.join(", ")}): ${parts.join("; ")}`
    : `${group.length} ${used.who} in ${where}${widened.length === 0 ? "" : ` (${widened.join(", ")})`}: ${parts.join("; ")}`;
  return { n: group.length, thin, widened, basis, events, reopened: reopenedOf };
}
