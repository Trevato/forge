/**
 * Conflict pairs (#6549): pairs of open pulls that touch the same files, most
 * files shared first, then lowest numbers, at most 20. A pull touching more
 * than 60 files is left out, as the hot-file limit does for wide pulls.
 * Pure: plain data in, plain data out.
 */

export interface PullFiles {
  readonly number: number;
  readonly files: readonly string[];
}

export interface ConflictPair {
  readonly a: number;
  readonly b: number;
  readonly shared: number;
}

const WIDE = 60;
const LIMIT = 20;

export function conflictPairs(pulls: readonly PullFiles[]): ConflictPair[] {
  const narrow = pulls
    .filter((p) => new Set(p.files).size <= WIDE)
    .map((p) => ({ number: p.number, files: new Set(p.files) }));
  const out: ConflictPair[] = [];
  for (let i = 0; i < narrow.length; i++) {
    for (let j = i + 1; j < narrow.length; j++) {
      const x = narrow[i]!;
      const y = narrow[j]!;
      if (x.number === y.number) continue;
      let shared = 0;
      for (const f of x.files) if (y.files.has(f)) shared++;
      if (shared > 0) out.push({ a: Math.min(x.number, y.number), b: Math.max(x.number, y.number), shared });
    }
  }
  out.sort((p, q) => q.shared - p.shared || p.a - q.a || p.b - q.b);
  return out.slice(0, LIMIT);
}
