/**
 * The /next filter (#11867): `?pillar=P7|Later` and `?q=word`, both read at
 * the boundary into plain data. A filter only hides rows; ranks, the cut line
 * and every move stay those of the whole ranking.
 */
export interface NextFilter {
  /** `P7` or `Later`, as asked; null when none was asked. */
  readonly pillar: string | null;
  /** What was typed, trimmed and capped; matching ignores its case, the input shows it as typed. */
  readonly q: string;
  /** A pillar value that is not `P` and digits or `Later`: it matches nothing. */
  readonly badPillar: boolean;
}

export const MAX_Q = 80;
const PILLAR_SHAPE = /^(P[0-9]{1,6}|Later)$/;

export function readFilter(params: URLSearchParams): NextFilter {
  const asked = (params.get("pillar") ?? "").trim();
  const q = (params.get("q") ?? "").trim().slice(0, MAX_Q);
  if (asked === "") return { pillar: null, q, badPillar: false };
  if (!PILLAR_SHAPE.test(asked)) return { pillar: null, q, badPillar: true };
  return { pillar: asked, q, badPillar: false };
}

export const filtered = (f: NextFilter): boolean => f.pillar !== null || f.q !== "" || f.badPillar;

/**
 * Whether a row with this title, served by pillar name `served` (`P7 Trust`, `Later`, or none),
 * shows.
 */
export function matches(f: NextFilter, title: string, served: string | undefined): boolean {
  if (f.badPillar) return false;
  if (f.pillar !== null && (served === undefined || served.split(" ")[0] !== f.pillar)) return false;
  return f.q === "" || title.toLowerCase().includes(f.q.toLowerCase());
}

/** The path back to this page with the filter, for a move form to return to. */
export function filterPath(base: string, f: NextFilter, rawPillar: string): string {
  const parts: string[] = [];
  if (f.pillar !== null || f.badPillar) parts.push(`pillar=${encodeURIComponent(rawPillar.trim().slice(0, 40))}`);
  if (f.q !== "") parts.push(`q=${encodeURIComponent(f.q)}`);
  return parts.length === 0 ? base : `${base}?${parts.join("&")}`;
}

/** The page's own wording for how many rows show. */
export function countWords(shown: number, total: number): string {
  return `${shown} of ${total}`;
}

/**
 * Where the cut line falls among the shown rows (their places in the whole
 * ranking): before the first one at or past `cutAt`, as an index, or -1 when
 * every shown row is on one side of it. A filter never moves the line, it only
 * hides it when no shown row is under it.
 */
export function markBefore(shown: readonly number[], cutAt: number): number {
  const i = shown.findIndex((at) => at >= cutAt);
  return i > 0 ? i : -1;
}
