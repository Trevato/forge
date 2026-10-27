/**
 * A day of the feed as at most three lines, one per repository, the biggest
 * change first. Plain rows in, plain lines out; the clock is `now`, passed in.
 */

export const DIGEST_WINDOW_MS = 24 * 3600 * 1000;
export const DIGEST_LINES = 3;
export const DIGEST_MIN_MS = 3600 * 1000;
export const DIGEST_MAX_MS = 7 * 24 * 3600 * 1000;

/** The window since the last visit: a day for a first visit, else at least an hour and at most a week. */
export function windowOf(lastVisit: number | undefined, now: number): number {
  if (lastVisit === undefined || !Number.isFinite(lastVisit)) return DIGEST_WINDOW_MS;
  return Math.min(DIGEST_MAX_MS, Math.max(DIGEST_MIN_MS, now - lastVisit));
}

/** The heading that names the window, e.g. `Since you were here · 2 days`. */
export function headingOf(windowMs: number): string {
  const hours = Math.round(windowMs / 3600000);
  if (hours < 24) return `Since you were here · ${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.round(hours / 24);
  return `Since you were here · ${days} ${days === 1 ? "day" : "days"}`;
}

export type DigestKind = "landed" | "released" | "failed" | "decided";
const KINDS: readonly DigestKind[] = ["landed", "released", "failed", "decided"];

export interface DigestEvent {
  readonly repo: string;
  readonly kind: DigestKind;
  /** Epoch milliseconds. */
  readonly at: number;
  readonly href: string;
  readonly weight: number;
}

export interface DigestLine {
  readonly repo: string;
  readonly says: string;
  readonly href: string;
}

interface Group {
  repo: string;
  total: number;
  heaviest: DigestEvent;
  heaviestW: number;
  counts: Record<DigestKind, number>;
}

export function digest(events: readonly DigestEvent[], now: number, windowMs: number = DIGEST_WINDOW_MS): DigestLine[] {
  const since = now - windowMs;
  const groups = new Map<string, Group>();
  for (const e of events) {
    if (!(e.at >= since && e.at <= now)) continue;
    const w = Number.isFinite(e.weight) && e.weight > 0 ? e.weight : 0;
    let g = groups.get(e.repo);
    if (!g) {
      g = { repo: e.repo, total: 0, heaviest: e, heaviestW: w, counts: { landed: 0, released: 0, failed: 0, decided: 0 } };
      groups.set(e.repo, g);
    }
    g.total += w;
    g.counts[e.kind] += 1;
    if (w > g.heaviestW || (w === g.heaviestW && e.at > g.heaviest.at)) {
      g.heaviest = e;
      g.heaviestW = w;
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.total - a.total || a.repo.localeCompare(b.repo))
    .slice(0, DIGEST_LINES)
    .map((g) => ({
      repo: g.repo,
      says: `${g.repo}: ${KINDS.filter((k) => g.counts[k] > 0)
        .map((k) => `${g.counts[k]} ${k}`)
        .join(", ")}`,
      href: g.heaviest.href,
    }));
}
