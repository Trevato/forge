/**
 * Reading the usage ledger (`core/usage.ts`) for one repository: what its
 * agent runs spent over a window, summed by subscription, agent and issue,
 * with the newest lines. Spend is the owner's own fact (`canSeeOwnerFacts`,
 * the predicate the run pages use for cost), so a reader who cannot write
 * the repository is refused. The API route and the MCP `usage` tool both
 * answer from here, so they never disagree.
 */

import type { App } from "../app.ts";
import { getIssuesByIds } from "../core/issues.ts";
import { canSeeOwnerFacts, type Repo } from "../core/repos.ts";
import { listSubscriptions } from "../core/subscriptions.ts";
import {
  recentUsage,
  usageTotals,
  type UsageEntry,
  type UsageTotals,
} from "../core/usage.ts";
import { getUsersByIds, type User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";

/** The window a read covers, in whole days back from now. */
export const USAGE_DAYS_DEFAULT = 7;
export const USAGE_DAYS_MAX = 90;
const RECENT = 20;

/** A window in days from text: a whole number 1–90, or the default when absent. */
export function usageDays(text: string | null | undefined): number | undefined {
  if (text === null || text === undefined || text === "")
    return USAGE_DAYS_DEFAULT;
  if (!/^\d{1,3}$/.test(text)) return undefined;
  const n = Number(text);
  return n >= 1 && n <= USAGE_DAYS_MAX ? n : undefined;
}

type Named<K extends string> = Omit<UsageTotals, "key"> & {
  readonly [P in K]: string | null;
};

export interface UsageReport {
  readonly app: string;
  readonly days: number;
  readonly since: string;
  /** Every run in the window, summed; zeros when there were none. */
  readonly total: Omit<UsageTotals, "key">;
  /** By account; `subscription: null` is the forge's own token. */
  readonly bySubscription: readonly Named<"subscription">[];
  readonly byAgent: readonly Named<"agent">[];
  /** By issue number; `issue: null` is a run about no issue. */
  readonly byIssue: readonly (Omit<UsageTotals, "key"> & {
    readonly issue: number | null;
  })[];
  readonly recent: readonly (Omit<UsageEntry, "repoId"> & {
    readonly subscription: string | null;
    readonly agent: string | null;
    readonly issue: number | null;
  })[];
}

const ZERO: Omit<UsageTotals, "key"> = {
  runs: 0,
  ok: 0,
  failed: 0,
  paused: 0,
  tokensIn: 0,
  tokensOut: 0,
  costUsd: 0,
  wallMs: 0,
};

const strip = ({ key: _, ...rest }: UsageTotals): Omit<UsageTotals, "key"> =>
  rest;

export function readUsage(
  app: App,
  user: User | undefined,
  repo: Repo,
  days: number,
  now: Date = new Date(),
): Result<UsageReport, "forbidden"> {
  if (!canSeeOwnerFacts(app.db, repo, user)) return err("forbidden");
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const filter = { since, repoId: repo.id };
  const db = app.db;
  const bySubscription = usageTotals(db, "subscription", filter);
  const byAgent = usageTotals(db, "agent", filter);
  const byIssue = usageTotals(db, "issue", filter);
  const recent = recentUsage(db, filter, RECENT);

  // Names, each looked up once for the whole report.
  const subscriptions = new Map(
    listSubscriptions(db).map((s) => [s.id, s.name]),
  );
  const agentIds = new Set<string>();
  const issueIds = new Set<string>();
  for (const row of [...byAgent, ...recent.map((r) => ({ key: r.agentId }))])
    if (row.key !== null) agentIds.add(row.key);
  for (const row of [...byIssue, ...recent.map((r) => ({ key: r.issueId }))])
    if (row.key !== null) issueIds.add(row.key);
  const agents = getUsersByIds(db, [...agentIds]);
  const issues = getIssuesByIds(db, [...issueIds]);
  const subscriptionName = (id: string | null): string | null =>
    id === null ? null : (subscriptions.get(id) ?? "a removed subscription");
  const agentName = (id: string | null): string | null =>
    id === null ? null : (agents.get(id)?.username ?? "a removed agent");
  const issueNumber = (id: string | null): number | null =>
    id === null ? null : (issues.get(id)?.number ?? null);

  const total = bySubscription.reduce<Omit<UsageTotals, "key">>(
    (sum, row) => ({
      runs: sum.runs + row.runs,
      ok: sum.ok + row.ok,
      failed: sum.failed + row.failed,
      paused: sum.paused + row.paused,
      tokensIn: sum.tokensIn + row.tokensIn,
      tokensOut: sum.tokensOut + row.tokensOut,
      costUsd: sum.costUsd + row.costUsd,
      wallMs: sum.wallMs + row.wallMs,
    }),
    ZERO,
  );

  return ok({
    app: `${repo.ownerName}/${repo.name}`,
    days,
    since,
    total,
    bySubscription: bySubscription.map((r) => ({
      subscription: subscriptionName(r.key),
      ...strip(r),
    })),
    byAgent: byAgent.map((r) => ({ agent: agentName(r.key), ...strip(r) })),
    byIssue: byIssue.map((r) => ({ issue: issueNumber(r.key), ...strip(r) })),
    recent: recent.map(({ repoId: _, ...r }) => ({
      ...r,
      subscription: subscriptionName(r.subscriptionId),
      agent: agentName(r.agentId),
      issue: issueNumber(r.issueId),
    })),
  });
}
