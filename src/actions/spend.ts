/**
 * Spend — what the crew spent over three spans, the last 5 hours, today
 * (since 00:00 UTC) and the last 7 days: by credential, by app, by agent,
 * by issue and by run kind, with the costliest runs of the week. Read from
 * the usage ledger (`core/usage.ts`), which a running session writes to as
 * it reports, so a run at work is counted already.
 *
 * Units, stated once: tokens are whole tokens (in = fresh + cache writes +
 * cache reads); `costUsd` is US dollars of the provider's list price, as
 * Claude Code reports it; `units` is ledger lines (runs).
 *
 * The 5-hour span is the last five hours, not any one account's window:
 * each credential's own window is its standing (`core/standing.ts`).
 *
 * Plain data, names resolved once per read; who may read it is the
 * caller's to decide (`readUsage` for one app, a site admin forge-wide).
 */

import type { App } from "../app.ts";
import { getIssuesByIds } from "../core/issues.ts";
import { getReposByIds } from "../core/repos.ts";
import { listCredentials, PLATFORM } from "../core/subscriptions.ts";
import {
  topUsage,
  usageTotals,
  type UsageBy,
  type UsageEntry,
  type UsageFilter,
  type UsageKind,
  type UsageOutcome,
} from "../core/usage.ts";
import { getUsersByIds } from "../core/users.ts";

export type SpanName = "5h" | "today" | "week";
export const SPANS: readonly SpanName[] = ["5h", "today", "week"];
const TOP = 10;

export interface SpendLine {
  /** The credential, `owner/name`, agent, `owner/name#n` or kind; `—` for none. */
  readonly name: string;
  readonly units: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
}

export interface SpendSpan {
  readonly span: SpanName;
  readonly since: string;
  readonly total: Omit<SpendLine, "name">;
  readonly byCredential: readonly SpendLine[];
  readonly byApp: readonly SpendLine[];
  readonly byAgent: readonly SpendLine[];
  readonly byIssue: readonly SpendLine[];
  readonly byKind: readonly SpendLine[];
}

export interface TopRun {
  readonly runId: string;
  readonly app: string;
  readonly credential: string;
  readonly agent: string;
  readonly issue: string;
  readonly kind: UsageKind;
  readonly outcome: UsageOutcome;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
  readonly at: string;
}

export interface Spend {
  readonly at: string;
  readonly spans: readonly SpendSpan[];
  /** The ten costliest runs of the last 7 days. */
  readonly top: readonly TopRun[];
}

/** Where each span begins at `now`. */
export function spanSince(span: SpanName, now: Date): string {
  const t = now.getTime();
  if (span === "5h") return new Date(t - 5 * 3_600_000).toISOString();
  if (span === "week") return new Date(t - 7 * 86_400_000).toISOString();
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  return day.toISOString();
}

/** The spend at `now`, forge-wide or for one app. */
export function readSpend(
  app: App,
  now: Date = new Date(),
  repoId?: string | undefined,
): Spend {
  const db = app.db;
  const read = SPANS.map((span) => {
    const filter: UsageFilter = {
      since: spanSince(span, now),
      until: now.toISOString(),
      repoId,
    };
    const by = (k: UsageBy) => usageTotals(db, k, filter);
    return {
      span,
      filter,
      credential: by("subscription"),
      repo: by("repo"),
      agent: by("agent"),
      issue: by("issue"),
      kind: by("kind"),
    };
  });
  const top = topUsage(
    db,
    { since: spanSince("week", now), until: now.toISOString(), repoId },
    TOP,
  );

  // Every name, looked up once.
  const ids = (pick: (s: (typeof read)[number]) => { key: string | null }[], more: (string | null)[]) =>
    [...new Set([...read.flatMap((s) => pick(s).map((r) => r.key)), ...more])].filter(
      (k): k is string => k !== null,
    );
  const credentials = new Map(listCredentials(db).map((c) => [c.id, c.name]));
  const issues = getIssuesByIds(db, ids((s) => s.issue, top.map((t) => t.issueId)));
  const repos = getReposByIds(db, [
    ...ids((s) => s.repo, top.map((t) => t.repoId)),
    ...[...issues.values()].map((i) => i.repoId),
  ]);
  const agents = getUsersByIds(db, ids((s) => s.agent, top.map((t) => t.agentId)));

  const platform = credentials.get(PLATFORM) ?? "platform (env)";
  const credentialName = (k: string | null): string =>
    k === null || k === PLATFORM
      ? platform
      : (credentials.get(k) ?? "a removed subscription");
  const appName = (k: string | null): string => {
    const r = k === null ? undefined : repos.get(k);
    return r === undefined ? "a removed app" : `${r.ownerName}/${r.name}`;
  };
  const agentName = (k: string | null): string =>
    k === null ? "—" : (agents.get(k)?.username ?? "a removed agent");
  const issueName = (k: string | null): string => {
    const i = k === null ? undefined : issues.get(k);
    if (i === undefined) return "—";
    return `${appName(i.repoId)}#${i.number}`;
  };

  const lines = (
    rows: ReturnType<typeof usageTotals>,
    name: (k: string | null) => string,
  ): SpendLine[] => {
    // Two keys can share a name (null and the platform): fold them.
    const out = new Map<string, SpendLine>();
    for (const r of rows) {
      const n = name(r.key);
      const was = out.get(n);
      out.set(n, {
        name: n,
        units: (was?.units ?? 0) + r.runs,
        tokensIn: (was?.tokensIn ?? 0) + r.tokensIn,
        tokensOut: (was?.tokensOut ?? 0) + r.tokensOut,
        costUsd: (was?.costUsd ?? 0) + r.costUsd,
      });
    }
    return [...out.values()].sort((a, b) => b.costUsd - a.costUsd || b.units - a.units);
  };

  return {
    at: now.toISOString(),
    spans: read.map((s) => {
      const byCredential = lines(s.credential, credentialName);
      return {
        span: s.span,
        since: s.filter.since,
        total: byCredential.reduce(
          (sum, l) => ({
            units: sum.units + l.units,
            tokensIn: sum.tokensIn + l.tokensIn,
            tokensOut: sum.tokensOut + l.tokensOut,
            costUsd: sum.costUsd + l.costUsd,
          }),
          { units: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 },
        ),
        byCredential,
        byApp: lines(s.repo, appName),
        byAgent: lines(s.agent, agentName),
        byIssue: lines(s.issue, issueName),
        byKind: lines(s.kind, (k) => k ?? "build"),
      };
    }),
    top: top.map((t: UsageEntry) => ({
      runId: t.runId,
      app: appName(t.repoId),
      credential: credentialName(t.subscriptionId),
      agent: agentName(t.agentId),
      issue: issueName(t.issueId),
      kind: t.kind ?? "build",
      outcome: t.outcome,
      tokensIn: t.tokensIn,
      tokensOut: t.tokensOut,
      costUsd: t.costUsd,
      at: t.at,
    })),
  };
}
