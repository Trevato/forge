/**
 * The space's pure arithmetic on the client (#10444): where an issue is at a
 * time, who of the crew is on what, how the view reads and writes the address
 * hash, and which issue a tap lands on. Plain data in, plain data out, no DOM.
 *
 * These are written as ordinary functions so a test can call them; the page
 * ships their source (`fn.toString()`, as `palette.ts` does), so what is
 * tested is what runs. Each is self-contained: it uses only its arguments
 * and the other functions here, by name.
 */

/** A landing slides from "in review" to "landed" over this much time (4 h). */
export const GLIDE_MS = 4 * 3600000;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Ease in and out, 0..1 to 0..1. */
export function ease(p: number): number {
  return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
}

/**
 * Where issue row `r` is at time `T`: [x, y, cluster, landed 0..1], or null
 * before it was opened. Row: [number, cluster, x, y, created, closed, title,
 * pull, bx, by, bcluster, hold, check]; (bx, by, bcluster) is where it sat
 * in review before it landed.
 */
export function placeAt(r: any[], T: number): number[] | null {
  if (r[4] > T) return null;
  const c = r[5];
  if (!c) return [r[2], r[3], r[1], 0];
  if (c > T) return [r[8], r[9], r[10], 0];
  const p = ease(clamp((T - c) / (4 * 3600000), 0, 1));
  return [r[8] + (r[2] - r[8]) * p, r[9] + (r[3] - r[9]) * p, p > 0.5 ? r[1] : r[10], p];
}

/**
 * The crew members on an issue at `T`: each one's latest run that started by
 * `T` and had not ended. `crew` is [{name, runs: [[issue, start, end]]}]
 * (end 0 while running); `slot` numbers those sharing an issue.
 */
export function crewAt(crew: any[], rows: any[][], T: number): any[] {
  const out: any[] = [];
  const byNum: Record<number, number> = {};
  crew.forEach(function (m: any, mi: number) {
    let cur: any = null;
    m.runs.forEach(function (run: any) {
      if (run[1] <= T && (run[2] === 0 || run[2] > T) && (!cur || run[1] > cur[1])) cur = run;
    });
    if (!cur) return;
    let row: any[] | null = null;
    for (let i = 0; i < rows.length; i++)
      if (rows[i]![0] === cur[0]) {
        row = rows[i]!;
        break;
      }
    if (!row) return;
    const pos = placeAt(row, T);
    if (!pos) return;
    const n = (byNum[cur[0]] = (byNum[cur[0]] || 0) + 1);
    out.push({ name: m.name, issue: cur[0], x: pos[0], y: pos[1], slot: n - 1, since: cur[1], mi: mi });
  });
  return out;
}

/**
 * The view an address hash names: `#x=…&y=…&z=…` (centre in world units, zoom
 * relative to Fit) and `&t=` (minutes since the epoch). `S` is
 * {world:{w,h}, weekStart, now}; `lim` is [min k, max k]. Missing or
 * non-numeric parts are left out; numbers are clamped into the plane.
 */
export function parseHash(hash: string, S: any, fitK: number, lim: number[]): any {
  const m: Record<string, number> = {};
  hash
    .replace(/^#/, "")
    .split("&")
    .forEach(function (kv: string) {
      const p = kv.split("=");
      m[p[0]!] = p[1] === undefined || p[1] === "" ? NaN : Number(p[1]);
    });
  const out: any = {};
  if (isFinite(m.x!) && isFinite(m.y!) && isFinite(m.z!) && m.z! > 0) {
    out.x = clamp(m.x!, 0, S.world.w);
    out.y = clamp(m.y!, 0, S.world.h);
    out.k = clamp(m.z! * fitK, lim[0]!, lim[1]!);
  }
  if (isFinite(m.t!) && m.t! * 60000 >= S.weekStart && m.t! * 60000 < S.now) out.t = m.t! * 60000;
  return out;
}

/** The hash for a view: the inverse of `parseHash` (centre rounded, zoom to 3 places). */
export function hashOf(view: any, fitK: number, live: boolean, T: number): string {
  let h = "x=" + Math.round(view.x) + "&y=" + Math.round(view.y) + "&z=" + (view.k / fitK).toFixed(3);
  if (!live) h += "&t=" + Math.round(T / 60000);
  return h;
}

/** The issue row whose cell holds world point (wx, wy) at `T`, nearest the centre; or null. */
export function pickIssue(rows: any[][], clusters: any[][], T: number, wx: number, wy: number): any[] | null {
  let best: any[] | null = null;
  let bd = 1e18;
  for (let j = 0; j < rows.length; j++) {
    const pos = placeAt(rows[j]!, T);
    if (!pos) continue;
    const cell = clusters[pos[2]!]![6];
    const dx = Math.abs(wx - pos[0]!);
    const dy = Math.abs(wy - pos[1]!);
    if (dx <= cell / 2 && dy <= cell / 2 && dx + dy < bd) {
      bd = dx + dy;
      best = rows[j]!;
    }
  }
  return best;
}

/** The source the page ships for these functions. */
export const viewJs = [clamp, ease, placeAt, crewAt, parseHash, hashOf, pickIssue].map((f) => f.toString()).join("\n");
