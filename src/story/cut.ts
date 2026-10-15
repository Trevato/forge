/**
 * Cutting a wave: from the waves already in the repository and the pulls
 * merged since the last one, the next `waves/<version>.md` as a draft. Pure:
 * plain data in, plain data out. The headline and highlights are marked
 * placeholders for a person to write; no model is asked.
 */

import {
  MIN_HIGHLIGHTS,
  parseWave,
  wavePath,
  writeWave,
  type Wave,
} from "./wave.ts";

export const PLACEHOLDER = "TODO";

export interface WaveFile {
  /** `waves/<name>.md`. */
  path: string;
  text: string;
}
export interface MergedPull {
  number: number;
  title: string;
  mergedAt: string;
  /** The head branch, so a wave's own pull is not listed in the next. */
  headBranch: string;
}
export interface Cut {
  version: string;
  path: string;
  text: string;
  pulls: number;
}
export type CutResult = { ok: true; value: Cut } | { ok: false; error: string };

const parts = (v: string): number[] =>
  v.replace(/-.*$/, "").split(".").map(Number);

const newer = (a: Wave, b: Wave): boolean => {
  const x = parts(a.version);
  const y = parts(b.version);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) > (y[i] ?? 0);
  return a.date > b.date;
};

/** A title that survives the wave's link syntax. */
const linkTitle = (n: number, title: string): string =>
  `#${n} ${title.replace(/[\[\]]/g, "").replace(/\s+/g, " ").trim()}`;

/**
 * Plan the next wave. `link` makes a pull's address; `today` is YYYY-MM-DD.
 * Every earlier wave must parse: the first that does not stops the cut,
 * named, with nothing written.
 */
export function cutWave(input: {
  waves: readonly WaveFile[];
  /** The pulls merged at or after a date (YYYY-MM-DD, "" for all). */
  merged: (since: string) => readonly MergedPull[];
  today: string;
  link: (number: number) => string;
}): CutResult {
  let last: Wave | undefined;
  const listed = new Set<number>();
  for (const f of input.waves) {
    const r = parseWave(f.path, f.text);
    if (!r.ok) return { ok: false, error: r.error.message };
    for (const p of r.value.pulls) {
      const n = /\/pulls\/(\d+)$/.exec(p.url)?.[1] ?? /^#(\d+) /.exec(p.title)?.[1];
      if (n !== undefined) listed.add(Number(n));
    }
    if (last === undefined || newer(r.value, last)) last = r.value;
  }
  const since = last?.date ?? "";
  // A pull merged on the last wave's own day may be in it already (or may
  // have landed after the cut): the date bounds the query, the list decides.
  const pulls = input.merged(since)
    .filter((p) => p.mergedAt.slice(0, 10) >= since && !listed.has(p.number))
    .filter((p) => !p.headBranch.startsWith("wave/"))
    .sort((a, b) => a.mergedAt.localeCompare(b.mergedAt) || a.number - b.number);
  if (pulls.length === 0)
    return {
      ok: false,
      error: last
        ? `Nothing has been merged since the last wave (${last.version}, ${last.date}).`
        : "Nothing has been merged yet.",
    };
  const p = last ? parts(last.version) : [0, 0, 0];
  const version = last ? `${p[0]}.${p[1]}.${(p[2] ?? 0) + 1}` : "0.1.0";
  const wave: Wave = {
    version,
    date: input.today,
    headline: `${PLACEHOLDER}: one line for this wave`,
    highlights: Array.from({ length: MIN_HIGHLIGHTS }, (_, i) => ({
      title: `${PLACEHOLDER}: highlight ${i + 1}`,
      why: `${PLACEHOLDER}: why it matters`,
    })),
    pulls: pulls.map((x) => ({
      title: linkTitle(x.number, x.title),
      url: input.link(x.number),
    })),
  };
  const text = writeWave(wave);
  if (!text.ok) return { ok: false, error: text.error.message };
  return {
    ok: true,
    value: { version, path: wavePath(version), text: text.value, pulls: pulls.length },
  };
}
