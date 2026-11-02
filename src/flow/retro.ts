/**
 * The week's retrospective (#8704): when a weekly window closes the forge
 * writes one frozen screen per repository, unasked — what shipped against the
 * projection it made when the window opened, how close the estimates ran,
 * what cost most for least, what got stuck and why — and ends it in at most
 * three proposals. A proposal changes nothing until a person takes it
 * (`actions/week.ts`). Plain code over the ledger, no model, no agent run.
 */

import type { Database } from "bun:sqlite";
import type { Repo } from "../core/repos.ts";
import { nextUp } from "../core/next_up.ts";
import type { Estimate } from "./estimate.ts";
import { cutLine, priceRows, projection, weekCapacity, type Confidence } from "./week.ts";

export const WEEK_MS = 7 * 86_400_000;
export const MAX_PROPOSALS = 3;
/** A run that ended failed this many times in the window marks an issue stuck. */
const STUCK_FAILS = 2;

export interface Projected {
  readonly sentence: string;
  readonly fits: readonly number[];
  readonly shipLow: number;
  readonly shipHigh: number;
  readonly confidence: Confidence;
  readonly ranges: Readonly<Record<string, { low: number; high: number }>>;
}

export interface Line {
  readonly number: number;
  readonly title: string;
  readonly usd: number;
  readonly why: string;
}

export interface Proposal {
  /** The one change a tap makes: put the issue behind the Later gate. */
  readonly kind: "not_now";
  readonly number: number;
  readonly words: string;
}

export interface Retro {
  readonly weekEnd: string;
  readonly shipped: readonly Line[];
  readonly projected: Projected | null;
  /** Shipped issues that had a range, and how many cost inside it. */
  readonly accuracy: { readonly compared: number; readonly inside: number };
  readonly costly: readonly Line[];
  readonly stuck: readonly Line[];
  readonly proposals: readonly Proposal[];
}

const usd = (n: number): string => `$${n.toFixed(2)}`;

/** The projection made now for the open window; null while no weekly reset is known. */
export function projectNow(db: Database, repo: Repo, now: Date): { weekEnd: string; projected: Projected } | null {
  const capacity = weekCapacity(db, now);
  if (capacity?.resetsAt == null) return null;
  const rows = nextUp(db, repo).rows;
  const priced = priceRows(db, repo.id, rows);
  const cut = cutLine(priced, capacity);
  const ranges: Record<string, { low: number; high: number }> = {};
  for (const p of priced) if (p.estimate.known) ranges[String(p.number)] = rangeOf(p.estimate);
  return {
    weekEnd: capacity.resetsAt,
    projected: {
      sentence: projection(cut, rows.length, capacity),
      fits: cut.fits,
      shipLow: cut.shipLow,
      shipHigh: cut.shipHigh,
      confidence: cut.confidence,
      ranges,
    },
  };
}

const rangeOf = (e: Estimate & { known: true }) => ({ low: e.low, high: e.high });

interface SpentRow {
  number: number;
  title: string;
  state: string;
  usd: number;
  failed: number;
  last: string;
}

/** What each issue touched in the window cost, and how its runs ended; the dearest first. */
export function windowSpend(db: Database, repoId: string, from: string, to: string): SpentRow[] {
  const runs = db
    .query<{ id: string; issue_id: string; cost_usd: number; state: string; summary: string }, [string, string, string]>(
      `SELECT r.id, r.issue_id, r.cost_usd, r.state, r.summary FROM run r
        WHERE r.kind = 'agent' AND r.started_at >= ?2 AND r.started_at < ?3 AND r.repo_id = ?1 AND r.issue_id IS NOT NULL`,
    )
    .all(repoId, from, to);
  const by = new Map<string, { usd: number; failed: number; last: string; lastId: string }>();
  for (const r of runs) {
    const was = by.get(r.issue_id) ?? { usd: 0, failed: 0, last: "", lastId: "" };
    was.usd += r.cost_usd;
    if (r.state === "failed") {
      was.failed++;
      if (r.id > was.lastId) {
        was.lastId = r.id;
        was.last = r.summary;
      }
    }
    by.set(r.issue_id, was);
  }
  const out: SpentRow[] = [];
  for (const [issueId, w] of by) {
    const i = db
      .query<{ number: number; title: string; state: string; sealed: number }, [string]>(
        "SELECT number, title, state, sealed FROM issue WHERE id = ?1 AND kind = 'issue'",
      )
      .get(issueId);
    if (i !== null && i.sealed === 0) out.push({ number: i.number, title: i.title, state: i.state, usd: w.usd, failed: w.failed, last: w.last });
  }
  return out.sort((a, b) => b.usd - a.usd || a.number - b.number);
}

/** Issues closed done in the window, with the spend of every run on each. */
export function windowShipped(db: Database, repoId: string, from: string, to: string): Line[] {
  return db
    .query<{ number: number; title: string; usd: number }, [string, string, string]>(
      `SELECT i.number, i.title, COALESCE((SELECT SUM(cost_usd) FROM run WHERE issue_id = i.id AND kind = 'agent'), 0) AS usd
         FROM issue i
        WHERE i.repo_id = ?1 AND i.kind = 'issue' AND i.state = 'closed' AND i.sealed = 0 AND i.close_reason = 'done'
          AND i.closed_at >= ?2 AND i.closed_at < ?3
        ORDER BY i.number`,
    )
    .all(repoId, from, to)
    .map((r) => ({ number: r.number, title: r.title, usd: r.usd, why: `cost ${usd(r.usd)}` }));
}

/** A failed run's words reduced to a class: its own output is never copied, since it may hold anything. */
export function failureClass(summary: string): string {
  const t = summary.toLowerCase();
  if (/time ?out|timed out/.test(t)) return "timed out";
  if (/limit|quota|rate/.test(t)) return "hit a usage limit";
  if (/check|ci\b|lint|type/.test(t)) return "its check failed";
  if (/test/.test(t)) return "its tests failed";
  if (/conflict|merge/.test(t)) return "hit a merge conflict";
  return "ended without finishing";
}

/** Pure: the retrospective from what was read. */
export function composeRetro(
  weekEnd: string,
  shipped: readonly Line[],
  spent: readonly SpentRow[],
  projected: Projected | null,
): Retro {
  let compared = 0;
  let inside = 0;
  for (const s of shipped) {
    const range = projected?.ranges[String(s.number)];
    if (range === undefined) continue;
    compared++;
    if (s.usd >= range.low && s.usd <= range.high) inside++;
  }
  const open = spent.filter((s) => s.state === "open" && s.usd > 0);
  const costly = open
    .slice(0, MAX_PROPOSALS)
    .map((s) => ({ number: s.number, title: s.title, usd: s.usd, why: `spent ${usd(s.usd)} and is still open` }));
  const stuck = open
    .filter((s) => s.failed >= STUCK_FAILS)
    .map((s) => ({
      number: s.number,
      title: s.title,
      usd: s.usd,
      why: `${s.failed} failed runs, the last ${failureClass(s.last)}`,
    }));
  const picked = new Map<number, Proposal>();
  for (const l of [...stuck, ...costly]) {
    if (picked.size >= MAX_PROPOSALS) break;
    if (!picked.has(l.number))
      picked.set(l.number, {
        kind: "not_now",
        number: l.number,
        words: `Put #${l.number} behind the Later gate: it ${l.why.startsWith("spent") ? l.why : `has ${l.why}`}.`,
      });
  }
  return { weekEnd, shipped, projected, accuracy: { compared, inside }, costly, stuck, proposals: [...picked.values()] };
}

/** Write the retrospective of the window that ended at `weekEnd`, once. True when this call wrote it. */
export function writeRetro(db: Database, repo: Repo, weekEnd: string, now: Date): boolean {
  const had = db
    .query<{ n: number }, [string, string]>("SELECT COUNT(*) AS n FROM week_retro WHERE repo_id = ?1 AND week_end = ?2")
    .get(repo.id, weekEnd);
  if (had !== null && had.n > 0) return false;
  const from = new Date(Date.parse(weekEnd) - WEEK_MS).toISOString();
  const stored = db
    .query<{ body: string }, [string, string]>("SELECT body FROM week_projection WHERE repo_id = ?1 AND week_end = ?2")
    .get(repo.id, weekEnd);
  const projected = stored === null ? null : (JSON.parse(stored.body) as Projected);
  const retro = composeRetro(weekEnd, windowShipped(db, repo.id, from, weekEnd), windowSpend(db, repo.id, from, weekEnd), projected);
  db.query("INSERT OR IGNORE INTO week_retro (repo_id, week_end, body, at) VALUES (?1, ?2, ?3, ?4)").run(
    repo.id,
    weekEnd,
    JSON.stringify(retro),
    now.toISOString(),
  );
  return true;
}

/** The latest retrospective of a repository, or undefined. */
export function latestRetro(db: Database, repoId: string): Retro | undefined {
  const row = db
    .query<{ body: string }, [string]>("SELECT body FROM week_retro WHERE repo_id = ?1 ORDER BY week_end DESC LIMIT 1")
    .get(repoId);
  return row === null ? undefined : (JSON.parse(row.body) as Retro);
}

/** Which proposals of a retrospective have been taken. */
export function takenOf(db: Database, repoId: string, weekEnd: string): Set<number> {
  return new Set(
    db
      .query<{ idx: number }, [string, string]>("SELECT idx FROM week_retro_taken WHERE repo_id = ?1 AND week_end = ?2")
      .all(repoId, weekEnd)
      .map((r) => r.idx),
  );
}

/**
 * Each hour: close the retrospective of every window that has ended, then keep
 * the projection of the window that is open. Only repositories with a ranked
 * list take part. Safe to call as often as you like.
 */
export function tickWeeks(db: Database, repos: readonly Repo[], now: Date): Repo[] {
  const wrote: Repo[] = [];
  for (const repo of repos) {
    const due = db
      .query<{ week_end: string }, [string, string]>(
        `SELECT p.week_end FROM week_projection p
          WHERE p.repo_id = ?1 AND p.week_end <= ?2
            AND NOT EXISTS (SELECT 1 FROM week_retro r WHERE r.repo_id = p.repo_id AND r.week_end = p.week_end)`,
      )
      .all(repo.id, now.toISOString());
    for (const d of due) if (writeRetro(db, repo, d.week_end, now)) wrote.push(repo);
    const open = projectNow(db, repo, now);
    if (open !== null)
      db.query("INSERT OR IGNORE INTO week_projection (repo_id, week_end, body, at) VALUES (?1, ?2, ?3, ?4)").run(
        repo.id,
        open.weekEnd,
        JSON.stringify(open.projected),
        now.toISOString(),
      );
  }
  return wrote;
}

/** Repositories that have a ranked list: the ones whose week is planned. */
export function plannedRepoIds(db: Database): string[] {
  return db
    .query<{ repo_id: string }, []>(
      `SELECT DISTINCT i.repo_id FROM issue_rank k JOIN issue i ON i.id = k.issue_id WHERE i.state = 'open'`,
    )
    .all()
    .map((r) => r.repo_id);
}
