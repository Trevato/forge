/**
 * A valve is one stored number per repository, 0 to 100: shut, a share of
 * the week's agent starts, or open (no valve at all). This file is the whole
 * rule, plain data in and plain data out, so the same valves and the same
 * queue always decide the same way:
 *
 * - shut: a run that has not started yet stays queued;
 * - a share: a run goes in its turn while the repository holds no more than
 *   its share of the week's starts, and yields to the others after that (it
 *   still starts when nothing else wants the slot);
 * - open: no change.
 *
 * A run carrying on after a pause (`resumed`) is already going and is never
 * held. Nothing here reads a clock or a table; `valve_store.ts` does.
 */

export const OPEN = 100;
export const SHUT = 0;

/** A valve level from the wire: a whole number 0 to 100, else nothing. */
export function parseLevel(raw: unknown): number | undefined {
  const n = typeof raw === "string" && /^\d{1,3}$/.test(raw.trim()) ? Number(raw) : raw;
  return typeof n === "number" && Number.isInteger(n) && n >= SHUT && n <= OPEN ? n : undefined;
}

export type Mode = "open" | "share" | "shut";

export const modeOf = (level: number): Mode => (level >= OPEN ? "open" : level <= SHUT ? "shut" : "share");

/** One sentence for a level, shared by the page, the terminal and the MCP. */
export function levelWords(level: number): string {
  if (level >= OPEN) return "Open: runs start as the crew picks them.";
  if (level <= SHUT) return "Shut: nothing new starts here until you open it.";
  return `${level}% of the week: runs start in turn up to that share, then yield to the other repositories.`;
}

export interface Waiting {
  readonly repoId: string;
  /** Carrying on after a pause or a restart: already going, so never held. */
  readonly resumed: boolean;
}

export interface Gated<T> {
  /** In the order they should start: those within their share first, then those that yield. */
  readonly order: T[];
  /** Shut out this tick. */
  readonly held: T[];
  /** In `order`, the ones that yield: over their share, started only if a slot is left. */
  readonly yielding: T[];
}

/**
 * Put the queue through the valves. `starts` is each repository's agent
 * starts so far this week; `levels` is the valves, a repository without one
 * being open. The result depends on nothing else.
 */
export function throughValves<T>(
  queued: readonly T[],
  waiting: (t: T) => Waiting,
  levels: ReadonlyMap<string, number>,
  starts: ReadonlyMap<string, number>,
): Gated<T> {
  const counts = new Map(starts);
  let total = 0;
  for (const n of counts.values()) total += n;
  const within: T[] = [];
  const yielding: T[] = [];
  const held: T[] = [];
  for (const t of queued) {
    const { repoId, resumed } = waiting(t);
    const level = resumed ? OPEN : (levels.get(repoId) ?? OPEN);
    if (level <= SHUT) {
      held.push(t);
      continue;
    }
    const mine = counts.get(repoId) ?? 0;
    if (level < OPEN && mine + 1 > Math.ceil((level / 100) * (total + 1))) {
      yielding.push(t);
      continue;
    }
    counts.set(repoId, mine + 1);
    total++;
    within.push(t);
  }
  return { order: [...within, ...yielding], held, yielding };
}

export interface Looks {
  readonly repoId: string;
  readonly n: number;
}

/** Fewer looks than this say nothing yet. */
export const LOOKS_MIN = 10;
/** A suggestion nearer than this to the valve is not worth a tap. */
const NEAR = 10;

/**
 * The level the looks suggest for a repository: its share of all looks,
 * rounded to the nearest 5 and kept within 5 to 95, so a suggestion is
 * never shut and never open. Nothing when there are too few looks, the
 * repository has none, or the valve is already near it.
 */
export function suggestedLevel(
  looks: readonly Looks[],
  repoId: string,
  current: number,
): number | undefined {
  let total = 0;
  let mine = 0;
  for (const l of looks) {
    total += l.n;
    if (l.repoId === repoId) mine += l.n;
  }
  if (total < LOOKS_MIN || mine === 0) return undefined;
  const level = Math.min(95, Math.max(5, Math.round(((mine / total) * 100) / 5) * 5));
  return Math.abs(level - current) < NEAR ? undefined : level;
}
