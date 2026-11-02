/**
 * Standing — where one subscription is in each of the windows its provider
 * meters it over: the 5-hour session window and the week. Per window: when
 * it started and resets, the cap, what is used, what remains, and what of
 * that the crew may spend once the operator's headroom for people is kept.
 *
 * Every figure says where it came from:
 * - `read` — the provider said it. Claude Code's refusal names the window
 *   and its reset (`crew/limits.ts`'s `limitOf`); the runner notes it here
 *   with `noteLimit`. While that reset is ahead, the window is full.
 * - `inferred` — worked out from the usage ledger (`core/usage.ts`).
 *
 * Units, stated once: money is US dollars of the provider's list-price
 * equivalent (`usage.cost_usd`), rounded to 1/10 000 of a dollar; tokens
 * are whole tokens; instants are ISO 8601, UTC.
 *
 * How the ledger is read:
 * - A run counts in the window it started in (`at - wallMs`).
 * - Where no reset is read, a window opens at the first run to start once
 *   the last one closed, and lasts its length (5 h, 7 d) — the way Claude
 *   meters a session. The chain starts two window-lengths back, or at the
 *   last read reset if that is later; nothing started means no window is
 *   open, and nothing is used.
 * - A weekly reset once read repeats every 7 days, so a past one projects
 *   to the next (`inferred`, being a projection).
 * - The cap is what the ledger shows spent in the window when the provider
 *   last said it was full. A person's own use of the account is not in the
 *   ledger, so the cap is a floor; no refusal yet means no cap (null), and
 *   then no remaining either.
 *
 * - The ledger is read five weeks back at most; a refusal older than that
 *   no longer sets a cap.
 *
 * Pure data: no authz, no events.
 */

import type { Database } from "bun:sqlite";

/** The usage windows a Claude subscription is metered over. */
export type LimitWindow = "5h" | "week";

export const WINDOWS: readonly LimitWindow[] = ["5h", "week"];

/** Each window's length, in milliseconds. */
export const WINDOW_MS: Readonly<Record<LimitWindow, number>> = {
  "5h": 5 * 3_600_000,
  week: 7 * 86_400_000,
};

/** The most of a window an operator may keep for people, in percent. */
export const HEADROOM_MAX = 90;

export type Source = "read" | "inferred";

/** A number or instant, and whether the provider said it or the ledger did. */
export interface Figure<T> {
  readonly value: T;
  readonly source: Source;
}

export interface WindowStanding {
  readonly window: LimitWindow;
  /** The open window; null when nothing has started one. */
  readonly startsAt: Figure<string> | null;
  readonly resetsAt: Figure<string> | null;
  /** US dollars the window holds; null until the provider has refused once. */
  readonly cap: Figure<number> | null;
  /** US dollars spent in the window by the crew. */
  readonly used: Figure<number>;
  readonly remaining: Figure<number> | null;
  /** US dollars of the window kept for people: cap × headroom share. */
  readonly kept: Figure<number> | null;
  /** What the crew may still spend: remaining − kept, never below 0. */
  readonly crewRemaining: Figure<number> | null;
  /** Ledger lines counted in `used`, and their tokens. */
  readonly runs: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  /** The provider's words when it last refused in this window kind. */
  readonly said: string | null;
}

export interface Standing {
  readonly subscriptionId: string;
  /** The share of each window the crew never spends, in whole percent. */
  readonly headroomPct: number;
  readonly windows: readonly WindowStanding[];
}

export interface Limit {
  readonly window: LimitWindow;
  readonly resetsAt: string;
  readonly observedAt: string;
  readonly said: string;
}

/**
 * The provider said `window` is full until `resetsAt`. The newest word for
 * a window replaces the last; an unknown subscription is ignored.
 */
export function noteLimit(
  db: Database,
  subscriptionId: string,
  limit: Limit,
): void {
  db.query(
    `INSERT INTO subscription_limit (subscription_id, span, resets_at, observed_at, said)
     SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM subscription WHERE id = ?1)
     ON CONFLICT (subscription_id, span) DO UPDATE SET
       resets_at = excluded.resets_at, observed_at = excluded.observed_at,
       said = excluded.said`,
  ).run(
    subscriptionId,
    limit.window,
    limit.resetsAt,
    limit.observedAt,
    limit.said.slice(0, 160),
  );
}

/** A whole percent 0–90 from text; undefined for anything else. */
export function headroomPct(text: string): number | undefined {
  if (!/^\d{1,2}$/.test(text.trim())) return undefined;
  const n = Number(text.trim());
  return n <= HEADROOM_MAX ? n : undefined;
}

/** The operator's share of each window kept for people; false if no such account. */
export function setHeadroom(
  db: Database,
  subscriptionId: string,
  pct: number,
): boolean {
  if (!Number.isInteger(pct) || pct < 0 || pct > HEADROOM_MAX) return false;
  return (
    db
      .query("UPDATE subscription SET headroom_pct = ?2 WHERE id = ?1")
      .run(subscriptionId, pct).changes > 0
  );
}

export function getHeadroom(
  db: Database,
  subscriptionId: string,
): number | undefined {
  return db
    .query<{ headroom_pct: number }, [string]>(
      "SELECT headroom_pct FROM subscription WHERE id = ?1",
    )
    .get(subscriptionId)?.headroom_pct;
}

/** One ledger line as the window arithmetic needs it. */
interface Spend {
  readonly start: number;
  readonly costUsd: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
}

const money = (n: number): number => Math.round(n * 10_000) / 10_000;
const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * The account's standing in each window at `now`, or undefined when there
 * is no such subscription. One ledger read covers both windows.
 */
export function standing(
  db: Database,
  subscriptionId: string,
  now: Date,
): Standing | undefined {
  return standings(db, [subscriptionId], now).get(subscriptionId);
}

const placeholders = (n: number, from = 1): string =>
  Array.from({ length: n }, (_, i) => `?${i + from}`).join(",");

/**
 * Several accounts' standing at `now`, keyed by id, in three statements
 * whatever their number: the headroom, the provider's last words, and one
 * ledger read from the earliest any of them needs. An unknown id is absent.
 */
export function standings(
  db: Database,
  subscriptionIds: readonly string[],
  now: Date,
): Map<string, Standing> {
  const ids = [...new Set(subscriptionIds)].slice(0, 400);
  const out = new Map<string, Standing>();
  if (ids.length === 0) return out;
  const pcts = new Map(
    db
      .query<{ id: string; headroom_pct: number }, string[]>(
        `SELECT id, headroom_pct FROM subscription WHERE id IN (${placeholders(ids.length)})`,
      )
      .all(...ids)
      .map((r) => [r.id, r.headroom_pct]),
  );
  if (pcts.size === 0) return out;
  const known = [...pcts.keys()];

  const limits = new Map<string, Map<LimitWindow, Limit>>();
  for (const r of db
    .query<
      {
        subscription_id: string;
        span: LimitWindow;
        resets_at: string;
        observed_at: string;
        said: string;
      },
      string[]
    >(
      `SELECT subscription_id, span, resets_at, observed_at, said FROM subscription_limit
       WHERE subscription_id IN (${placeholders(known.length)})`,
    )
    .all(...known)) {
    const of = limits.get(r.subscription_id) ?? new Map<LimitWindow, Limit>();
    of.set(r.span, {
      window: r.span,
      resetsAt: r.resets_at,
      observedAt: r.observed_at,
      said: r.said,
    });
    limits.set(r.subscription_id, of);
  }

  const t = now.getTime();
  // Two weeks back holds every window's chain; a refusal's window is read
  // too, so long as it opened within the last five weeks.
  const floor = t - 5 * WINDOW_MS.week;
  const sinceOf = (id: string): number =>
    Math.max(
      floor,
      Math.min(
        t - 2 * WINDOW_MS.week,
        ...[...(limits.get(id)?.values() ?? [])].map(
          (l) => Date.parse(l.resetsAt) - WINDOW_MS[l.window],
        ),
      ),
    );
  const since = new Map(known.map((id) => [id, sinceOf(id)]));
  const earliest = Math.min(...since.values());

  const spends = new Map<string, Spend[]>(known.map((id) => [id, []]));
  for (const r of db
    .query<
      {
        subscription_id: string;
        at: string;
        wall_ms: number;
        cost_usd: number;
        tokens_in: number;
        tokens_out: number;
      },
      string[]
    >(
      `SELECT subscription_id, at, wall_ms, cost_usd, tokens_in, tokens_out FROM usage
       WHERE subscription_id IN (${placeholders(known.length, 2)}) AND at >= ?1`,
    )
    .all(iso(earliest), ...known)) {
    // Each account reads from its own floor, as if read alone.
    if (r.at < iso(since.get(r.subscription_id)!)) continue;
    spends.get(r.subscription_id)!.push({
      start: Date.parse(r.at) - r.wall_ms,
      costUsd: r.cost_usd,
      tokensIn: r.tokens_in,
      tokensOut: r.tokens_out,
    });
  }

  for (const id of known) {
    const pct = pcts.get(id)!;
    const mine = spends.get(id)!.sort((a, b) => a.start - b.start);
    const of = limits.get(id);
    out.set(id, {
      subscriptionId: id,
      headroomPct: pct,
      windows: WINDOWS.map((w) =>
        windowStanding(w, of?.get(w), mine, pct, t, since.get(id)!),
      ),
    });
  }
  return out;
}

function windowStanding(
  window: LimitWindow,
  limit: Limit | undefined,
  spends: readonly Spend[],
  pct: number,
  t: number,
  since: number,
): WindowStanding {
  const length = WINDOW_MS[window];
  const reset = limit === undefined ? undefined : Date.parse(limit.resetsAt);

  // Where the open window lies, and on whose word.
  let open: { start: number; end: number; source: Source } | undefined;
  if (reset !== undefined && reset > t) {
    open = { start: reset - length, end: reset, source: "read" };
  } else if (reset !== undefined && window === "week") {
    const end = reset + Math.ceil((t - reset + 1) / length) * length;
    open = { start: end - length, end, source: "inferred" };
  } else {
    let start = -Infinity;
    let end = -Infinity;
    const from = Math.max(t - 2 * length, reset ?? -Infinity);
    for (const s of spends) {
      if (s.start < from || s.start > t) continue;
      if (s.start >= end) {
        start = s.start;
        end = s.start + length;
      }
    }
    if (end > t) open = { start, end, source: "inferred" };
  }

  const sum = (from: number, to: number) => {
    let costUsd = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let runs = 0;
    for (const s of spends)
      if (s.start >= from && s.start <= to) {
        costUsd += s.costUsd;
        tokensIn += s.tokensIn;
        tokensOut += s.tokensOut;
        runs++;
      }
    return { costUsd: money(costUsd), tokensIn, tokensOut, runs };
  };

  const spent =
    open === undefined
      ? { costUsd: 0, tokensIn: 0, tokensOut: 0, runs: 0 }
      : sum(open.start, Math.min(t, open.end - 1));

  // The cap: what the crew had spent in the window the provider last
  // called full, up to the moment it said so. A refusal older than the
  // ledger read is stale, and gives none.
  const capUsd =
    limit === undefined || reset === undefined || reset - length < since
      ? 0
      : sum(reset - length, Date.parse(limit.observedAt)).costUsd;
  const cap: Figure<number> | null =
    capUsd > 0 ? { value: capUsd, source: "inferred" } : null;

  const full = open?.source === "read";
  const remaining: Figure<number> | null = full
    ? { value: 0, source: "read" }
    : cap === null
      ? null
      : { value: money(Math.max(0, cap.value - spent.costUsd)), source: "inferred" };
  const kept: Figure<number> | null =
    cap === null ? null : { value: money((cap.value * pct) / 100), source: "inferred" };
  const crewRemaining: Figure<number> | null =
    remaining === null
      ? null
      : remaining.source === "read"
        ? remaining
        : {
            value: money(Math.max(0, remaining.value - (kept?.value ?? 0))),
            source: "inferred",
          };

  return {
    window,
    startsAt:
      open === undefined ? null : { value: iso(open.start), source: open.source },
    resetsAt:
      open === undefined ? null : { value: iso(open.end), source: open.source },
    cap,
    used: { value: spent.costUsd, source: "inferred" },
    remaining,
    kept,
    crewRemaining,
    runs: spent.runs,
    tokensIn: spent.tokensIn,
    tokensOut: spent.tokensOut,
    said: limit?.said ?? null,
  };
}

/** The share of a window's cap still free, in whole percent 0–100; null with no cap. */
export function freePct(cap: number | null, used: number): number | null {
  if (cap === null || cap <= 0) return null;
  return Math.max(0, Math.min(100, Math.round(((cap - used) / cap) * 100)));
}
