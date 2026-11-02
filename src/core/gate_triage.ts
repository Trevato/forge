/**
 * A one-time look at what the Later gate holds (#8700, #8813), from titles
 * and bodies: one pass of plain word counting, no model, no run, nothing
 * stored. Unchosen ideas are dropped, not tracked (Shape Up), so close is
 * the default. Two things change that, each named in the verdict:
 *   keep   the issue joins a bet or a pillar's open work: the work serves a
 *          pillar, or names it as `#N` (or it names the work), so it stays
 *          behind the gate;
 *   merge  another held issue says the same thing (the older survives):
 *          the duplicate's body is appended to it on apply, never replaced.
 * A found-done issue closes first. Only done and merge start ticked (a
 * merge loses no words); the rest are the person's to tick, and one that
 * open work waits for is flagged, for closing it parks that work. A closed
 * one stays findable and one tap revives it. The lot is grouped by theme:
 * the pillar an issue serves, else the word its titles share most. Nothing
 * here changes an issue (`actions/gate_review.ts` applies the approval).
 */

export interface Held {
  readonly number: number;
  readonly title: string;
  readonly body?: string;
  /** Open issues that wait for this one: closing it parks them. */
  readonly waiting: number;
}

/** Open work outside the gate that held issues can join: a pillar's, or a bet. */
export interface Anchor {
  readonly number: number;
  /** `P0 Trust`, or `Bet`. */
  readonly label: string;
  readonly title: string;
  readonly body: string;
}

export type Verdict =
  | { readonly kind: "close"; readonly why: string; readonly reason: "done" | "dropped" }
  | { readonly kind: "keep"; readonly why: string; readonly reason: "kept"; readonly anchor: number }
  | { readonly kind: "merge"; readonly why: string; readonly reason: "merged"; readonly into: number };

export interface Triaged {
  readonly number: number;
  readonly title: string;
  readonly waiting: number;
  readonly verdict: Verdict;
}

export interface Theme {
  readonly name: string;
  /** The group is a pillar's, not a shared word. */
  readonly pillar?: true;
  readonly items: readonly Triaged[];
}

/** A group's issues counted by verdict: the one line a group reads as. */
export function tally(items: readonly Triaged[]): { close: number; keep: number; merge: number } {
  const n = { close: 0, keep: 0, merge: 0 };
  for (const i of items) n[i.verdict.kind]++;
  return n;
}

/** The tally as one line, `3 close · 1 keep`: a verdict with none is left out. */
export function tallyLine(items: readonly Triaged[]): string {
  const n = tally(items);
  return [`${n.close} close`, `${n.keep} keep`, `${n.merge} merge`].filter((p) => !p.startsWith("0 ")).join(" · ");
}

const STOP = new Set(
  "a an and are as at be by for from has have how in is it its of on or that the this to was we with when what who which not no can do does your you our new add make use used using into out up per via issue issues".split(
    " ",
  ),
);

/** Lowercase words of three letters or more, the stop words left out. */
export function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []).filter(
    (w) => !STOP.has(w),
  );
}

/** Whether a candidate starts ticked: only one the crew found done on main. */
export const startsTicked = (t: Triaged): boolean =>
  t.verdict.reason === "done" || t.verdict.kind === "merge";

/** Words two issues share, over all they use: 1 is the same set. */
function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** Titles this alike, or title and body this alike, are one issue said twice. */
export const DUPLICATE_TITLE = 0.7;
export const DUPLICATE_TEXT = 0.6;
/** Fewer words than this say too little to call a duplicate. */
const DUPLICATE_WORDS = 3;

const mentions = (text: string, n: number): boolean =>
  new RegExp(`(?<![\\w#])#${n}(?!\\w)`).test(text);

/** The held issue each duplicate folds into: the oldest of its group, by number. */
export function duplicates(held: readonly Held[]): Map<number, number> {
  const title = new Map(held.map((h) => [h.number, new Set(words(h.title))]));
  const text = new Map(held.map((h) => [h.number, new Set(words(`${h.title} ${h.body ?? ""}`))]));
  const parent = new Map(held.map((h) => [h.number, h.number]));
  const root = (n: number): number => (parent.get(n) === n ? n : root(parent.get(n)!));
  const sorted = [...held].sort((a, b) => a.number - b.number);
  for (let i = 0; i < sorted.length; i++)
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!.number;
      const b = sorted[j]!.number;
      const ta = title.get(a)!;
      const tb = title.get(b)!;
      const xa = text.get(a)!;
      const xb = text.get(b)!;
      const alike =
        (ta.size >= DUPLICATE_WORDS && tb.size >= DUPLICATE_WORDS && overlap(ta, tb) >= DUPLICATE_TITLE) ||
        (xa.size >= 2 * DUPLICATE_WORDS && xb.size >= 2 * DUPLICATE_WORDS && overlap(xa, xb) >= DUPLICATE_TEXT);
      if (!alike) continue;
      const ra = root(a);
      const rb = root(b);
      if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
    }
  const out = new Map<number, number>();
  for (const h of held) if (root(h.number) !== h.number) out.set(h.number, root(h.number));
  return out;
}

/** The anchor a held issue joins: one that names it, or that it names. */
function anchorOf(h: Held, anchors: readonly Anchor[]): Anchor | undefined {
  return anchors.find(
    (a) => mentions(`${a.title}\n${a.body}`, h.number) || mentions(`${h.title}\n${h.body ?? ""}`, a.number),
  );
}

/** A theme needs this many issues; a word on fewer is not a theme. */
export const THEME_MIN = 3;
/** Themes shown; the rest go under `OTHER`. */
export const THEMES_MAX = 8;
export const OTHER = "Other";

/** The candidate close for each held issue, under the theme its title belongs to. */
export function triage(
  held: readonly Held[],
  done: ReadonlySet<number> = new Set(),
  anchors: readonly Anchor[] = [],
  serves: ReadonlyMap<number, string> = new Map(),
): Theme[] {
  const folds = duplicates(held.filter((h) => !done.has(h.number)));
  // Issues that serve a pillar group under it; the rest by shared title words.
  const loose = held.filter((h) => serves.get(h.number) === undefined);
  const sets = new Map(loose.map((h) => [h.number, new Set(words(h.title))]));
  // A theme is a word many titles share: each issue goes under the commonest
  // of its words that is common enough, ties to the shorter, then alphabetical.
  const freq = new Map<string, number>();
  for (const s of sets.values()) for (const w of s) freq.set(w, (freq.get(w) ?? 0) + 1);
  const chosen = [...freq]
    .filter(([, n]) => n >= THEME_MIN)
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]))
    .slice(0, THEMES_MAX)
    .map(([w]) => w);
  const groups = new Map<string, Triaged[]>(chosen.map((w) => [w, []]));
  const other: Triaged[] = [];
  const byPillar = new Map<string, Triaged[]>();
  for (const h of held) {
    const joined = anchorOf(h, anchors);
    const pillar = serves.get(h.number);
    const verdict: Verdict = done.has(h.number)
      ? { kind: "close", why: "the crew found it done on main", reason: "done" }
      : pillar !== undefined
        ? { kind: "keep", why: `serves ${pillar}: stays behind the gate`, reason: "kept", anchor: 0 }
        : joined !== undefined
          ? { kind: "keep", why: `joins ${joined.label} #${joined.number}: stays behind the gate`, reason: "kept", anchor: joined.number }
          : folds.has(h.number)
            ? { kind: "merge", why: `says the same as #${folds.get(h.number)}: merge into it, words appended`, reason: "merged", into: folds.get(h.number)! }
            : { kind: "close", why: "not chosen: an idea that matters comes back", reason: "dropped" };
    const row = { number: h.number, title: h.title, waiting: h.waiting, verdict };
    if (pillar !== undefined) {
      byPillar.set(pillar, [...(byPillar.get(pillar) ?? []), row]);
      continue;
    }
    const theme = chosen.find((w) => sets.get(h.number)!.has(w));
    if (theme === undefined) other.push(row);
    else groups.get(theme)!.push(row);
  }
  const pillars: Theme[] = [...byPillar]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, items]) => ({ name, pillar: true as const, items }));
  const out = [...pillars, ...[...groups]
    .filter(([, items]) => items.length > 0)
    .map(([name, items]) => ({ name, items }))];
  return other.length === 0 ? out : [...out, { name: OTHER, items: other }];
}
