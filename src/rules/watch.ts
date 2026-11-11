/**
 * The rule watcher's four reads, each one function returning its findings and
 * actions (#7560). The duty calls them in turn; each is idempotent (one open
 * issue per title, one comment per text). A probe names the real query the
 * finding rests on, so anyone can run it again.
 */

import type { Database } from "bun:sqlite";
import type { EventBus } from "../core/events.ts";
import type { Repo } from "../core/repos.ts";
import type { Finding } from "../maintain/duty.ts";
import { BUDGET_SQL, budgetReruns, fileHeadroom, FILE_AT as BUDGET_AT } from "./budget_rerun.ts";
import { commentBreakers, FAILED_CHECKS_SQL } from "./breaker.ts";
import { FLAKE_TREND_SQL, fileWorst, flakeTrend, trendLines, weekOf } from "./flake_trend.ts";
import { fileGateOnly, GATE_RED_SQL, gateOnlyReds, FILE_AT as GATE_AT, OWN_CHECK_SQL } from "./gate_only.ts";

export interface Read {
  readonly findings: Finding[];
  readonly actions: string[];
}

export interface Watch {
  readonly db: Database;
  readonly bus: EventBus;
  readonly repos: ReadonlyMap<string, Pick<Repo, "id" | "ownerId">>;
  readonly now: Date;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const probe = (w: Watch, what: string, number: number) => ({ kind: "query" as const, what, number, at: w.now.toISOString() });
const numbered = (list: readonly number[]): string => `#${list.join(", #")}`;

export function breakers(w: Watch): Read {
  const posted = commentBreakers(w.db, w.now);
  if (posted.length === 0) return { findings: [], actions: [] };
  return {
    findings: [{ summary: `${plural(posted.length, "pull")} red on a repo rule`, probe: probe(w, FAILED_CHECKS_SQL, posted.length) }],
    actions: [`commented the rule and its fix on ${posted.length} pull(s)`],
  };
}

export function gateOnly(w: Watch): Read {
  const at = w.now.getTime();
  const reds = gateOnlyReds(w.db, at).filter((g) => g.gates.length >= GATE_AT);
  const filed = fileGateOnly(w.db, w.bus, w.repos, at);
  const findings: Finding[] = [];
  if (reds.length > 0)
    findings.push({
      summary: `${plural(reds.length, "test")} red in the gate and green on the pull, ${GATE_AT}+ times this week`,
      probe: probe(w, `${GATE_RED_SQL}; ${OWN_CHECK_SQL}`, reds.length),
    });
  return { findings, actions: filed.length > 0 ? [`filed gate-only issue(s) ${numbered(filed)}`] : [] };
}

/** `previousStart`: when the duty last started before this run; the week's trend is said on the first run of a week. */
export function flakeWeek(w: Watch, previousStart: number | undefined): Read {
  const at = w.now.getTime();
  const trend = flakeTrend(w.db, at);
  if (trend.length === 0) return { findings: [], actions: [] };
  const label = weekOf(at);
  const worst = fileWorst(w.db, w.bus, w.repos, trend);
  const firstOfWeek = previousStart === undefined || previousStart < Date.parse(label);
  const actions = worst.length > 0 ? [`filed flake issue(s) ${numbered(worst)}`] : [];
  if (!firstOfWeek && worst.length === 0) return { findings: [], actions };
  return {
    findings: [{ summary: `flake trend ${label}: ${trendLines(trend.slice(0, 5)).join("; ")}`, probe: probe(w, FLAKE_TREND_SQL, trend.length) }],
    actions,
  };
}

export function budgets(w: Watch): Read {
  const at = w.now.getTime();
  const reruns = budgetReruns(w.db, at).filter((b) => b.passes >= BUDGET_AT);
  const filed = fileHeadroom(w.db, w.bus, w.repos, at);
  const findings: Finding[] = [];
  if (reruns.length > 0)
    findings.push({
      summary: `${plural(reruns.length, "budget test")} re-run green ${BUDGET_AT}+ times this week`,
      probe: probe(w, BUDGET_SQL, reruns.length),
    });
  return { findings, actions: filed.length > 0 ? [`filed headroom issue(s) ${numbered(filed)}`] : [] };
}
