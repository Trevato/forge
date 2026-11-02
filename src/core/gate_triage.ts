/**
 * A one-time look at what the Later gate holds (#8700), from titles alone:
 * no model, no run, nothing stored. Unchosen ideas are dropped, not tracked
 * (Shape Up): every held issue is a candidate to close, and only one the
 * crew found done on main starts ticked; the rest are the person's to tick,
 * and one that open work waits for is flagged, for closing it parks that
 * work. Unticked is keep. A closed one stays findable and one tap revives
 * it. The lot is grouped by theme, the word its titles share most. Nothing
 * here changes an issue (`actions/gate_review.ts` applies the approval).
 */

export interface Held {
  readonly number: number;
  readonly title: string;
  /** Open issues that wait for this one: closing it parks them. */
  readonly waiting: number;
}

export interface Verdict {
  readonly kind: "close";
  readonly why: string;
  readonly reason: "done" | "dropped";
}

export interface Triaged {
  readonly number: number;
  readonly title: string;
  readonly waiting: number;
  readonly verdict: Verdict;
}

export interface Theme {
  readonly name: string;
  readonly items: readonly Triaged[];
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
export const startsTicked = (t: Triaged): boolean => t.verdict.reason === "done";

/** A theme needs this many issues; a word on fewer is not a theme. */
export const THEME_MIN = 3;
/** Themes shown; the rest go under `OTHER`. */
export const THEMES_MAX = 8;
export const OTHER = "Other";

/** The candidate close for each held issue, under the theme its title belongs to. */
export function triage(
  held: readonly Held[],
  done: ReadonlySet<number> = new Set(),
): Theme[] {
  const sets = new Map(held.map((h) => [h.number, new Set(words(h.title))]));
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
  for (const h of held) {
    const verdict: Verdict = done.has(h.number)
      ? { kind: "close", why: "the crew found it done on main", reason: "done" }
      : { kind: "close", why: "not chosen: an idea that matters comes back", reason: "dropped" };
    const row = { number: h.number, title: h.title, waiting: h.waiting, verdict };
    const theme = chosen.find((w) => sets.get(h.number)!.has(w));
    if (theme === undefined) other.push(row);
    else groups.get(theme)!.push(row);
  }
  const out = [...groups]
    .filter(([, items]) => items.length > 0)
    .map(([name, items]) => ({ name, items }));
  return other.length === 0 ? out : [...out, { name: OTHER, items: other }];
}
