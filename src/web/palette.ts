/**
 * The command palette's pure half: how a row scores against what was typed,
 * and how the scored rows become the grouped list the dialog shows. Plain
 * TypeScript, so a test can call it — and, because Bun's
 * `Function.prototype.toString` hands back the *transpiled* JavaScript, the
 * same two functions ride inside the shell script as `paletteHelpersJs`.
 * One implementation, no build step, no second copy to drift.
 *
 * The rule that keeps that honest: each function below is self-contained.
 * It may call the other by name — the script embeds both in one scope — and
 * nothing else, because nothing else is there.
 */

/** One row the palette can show: title, href, group, an optional detail. */
export interface PaletteRow {
  readonly t: string;
  readonly h: string;
  readonly g: string;
  readonly d?: string;
  /** A repository's bare name: an exact or prefix landing on it outranks everything. */
  readonly n?: string;
  /** The viewer owns this repository: its name matches lead the others. */
  readonly m?: 1;
  /** What the app is, for a repository that has one ("App · running"); shown, never scored. */
  readonly x?: string;
  /** Where Cmd/Ctrl+Enter goes: the app itself. */
  readonly o?: string;
}

/** A heading and the rows under it, best first. */
export interface PaletteGroup {
  readonly title: string;
  readonly rows: PaletteRow[];
}

/**
 * How well `text` answers `query`; 0 means it does not. Case-blind, and
 * every whitespace-separated word of the query must land somewhere. A word
 * scores by how it lands: exact, then a prefix, then at the start of a word,
 * then anywhere as a substring, then as letters in order — where a run of
 * adjacent letters is worth more than scattered ones and an early landing
 * more than a late one. Forgiving on purpose: "nw iss" should find "New
 * issue", and "sett" should not find "SSH keys".
 */
export function fuzzyScore(query: string, text: string): number {
  const t = text.toLowerCase();
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== "");
  if (words.length === 0) return 1;
  let total = 0;
  for (const w of words) {
    let s = 0;
    const at = t.indexOf(w);
    if (at !== -1) {
      s = 600 - Math.min(at, 100);
      if (at === 0) s += 300;
      else if (!/[a-z0-9]/.test(t.charAt(at - 1))) s += 150;
      if (w.length === t.length) s += 100;
    } else {
      let i = 0;
      let prev = -2;
      for (let j = 0; j < t.length && i < w.length; j++) {
        if (t.charAt(j) !== w.charAt(i)) continue;
        s += 10;
        if (j === prev + 1) s += 8;
        else if (j === 0 || !/[a-z0-9]/.test(t.charAt(j - 1))) s += 6;
        else s -= Math.min(j - prev - 1, 8);
        prev = j;
        i++;
      }
      if (i < w.length) return 0;
    }
    total += s;
  }
  return total;
}

/**
 * The list the dialog shows: the rows that answer `query`, best first, cut
 * to `limit`, then folded into groups in the order their best row earned —
 * so the best row leads its group and the best group leads the list. An
 * empty query keeps the rows' own order (the caller put recents first). A
 * row seen twice by href is kept once — the index and the server can both
 * name a repository — and a row whose href is in `recent` gets a nudge,
 * because what you chose last time is probably what you mean now.
 */
export function rankPalette(
  rows: readonly PaletteRow[],
  query: string,
  recent: readonly string[],
  limit: number,
): PaletteGroup[] {
  const q = query.trim();
  const seen = new Set<string>();
  const scored: { r: PaletteRow; s: number; i: number }[] = [];
  rows.forEach((r, i) => {
    if (seen.has(r.h)) return;
    let s = 1;
    if (q !== "") {
      const title = fuzzyScore(q, r.t);
      const detail = r.d === undefined ? 0 : fuzzyScore(q, r.d);
      if (title === 0 && detail === 0) return;
      s = title + detail / 2 + (recent.indexOf(r.h) === -1 ? 0 : 50);
      // A repository named by what was typed beats every other kind of
      // landing: exact, then prefix; the viewer's own ahead of the rest.
      if (r.n !== undefined && !/\s/.test(q)) {
        const ql = q.toLowerCase();
        const nl = r.n.toLowerCase();
        const tl = r.t.toLowerCase();
        const tier = nl === ql || tl === ql ? 3000 : nl.indexOf(ql) === 0 || tl.indexOf(ql) === 0 ? 2000 : 0;
        if (tier > 0) s = tier + (r.m === 1 ? 500 : 0) + s / 10;
      }
    }
    seen.add(r.h);
    scored.push({ r, s, i });
  });
  if (q !== "") {
    scored.sort(
      (a, b) => b.s - a.s || a.r.t.length - b.r.t.length || a.i - b.i,
    );
  }
  const groups: PaletteGroup[] = [];
  for (const { r } of scored.slice(0, limit)) {
    let g = groups.find((x) => x.title === r.g);
    if (g === undefined) {
      g = { title: r.g, rows: [] };
      groups.push(g);
    }
    g.rows.push(r);
  }
  return groups;
}

/**
 * Whether the bare search page opens the palette sheet by itself: the page
 * asked for it (`marked`) and the viewport is phone width, below the 720px
 * at which `.palette` stops being a bottom sheet (style/components.ts).
 * Self-contained, like the others; shipped in the script.
 */
export function opensAsSheet(marked: boolean, width: number): boolean {
  return marked && width > 0 && width < 720;
}

/** A row opened before: where, how it was labelled, how often, and when last. */
export interface PaletteUse {
  readonly t: string;
  readonly h: string;
  readonly g: string;
  /** Times opened. */
  readonly c: number;
  /** Milliseconds since the epoch of the last opening. */
  readonly l: number;
}

/**
 * Remembered rows in frecency order, best first: each opening is worth one,
 * halved for every week since the last, so a row opened often and a row
 * opened just now both lead a row opened once long ago. (Mozilla-style
 * frecency, reduced to count × 2^(-weeks); the decay is applied to the whole
 * count, an approximation that needs no per-visit history.) Ties go to the
 * later opening. Returns a new array; `now` is passed in so the function is
 * pure. Self-contained, shipped in the script.
 */
export function frecencyOrder<T extends { c: number; l: number }>(uses: readonly T[], now: number): T[] {
  const week = 7 * 24 * 3600 * 1000;
  const score = (u: T) => u.c * Math.pow(0.5, Math.max(0, now - u.l) / week);
  return uses.slice().sort((a, b) => score(b) - score(a) || b.l - a.l);
}

/**
 * What the browser's stored list means: anything that is not an array of
 * `{t, h}` with a same-origin `h` is dropped; a missing or bad count is one
 * opening, a missing time is the epoch (oldest). Cut to `max`. Self-contained.
 */
export function readUses(raw: unknown, max: number): PaletteUse[] {
  if (!Array.isArray(raw)) return [];
  const out: PaletteUse[] = [];
  for (const r of raw) {
    if (out.length >= max) break;
    if (!r || typeof r.t !== "string" || typeof r.h !== "string" || r.h.charAt(0) !== "/") continue;
    out.push({
      t: r.t,
      h: r.h,
      g: typeof r.g === "string" ? r.g : "",
      c: typeof r.c === "number" && r.c >= 1 ? Math.min(r.c, 1e6) : 1,
      l: typeof r.l === "number" && r.l > 0 ? r.l : 1,
    });
  }
  return out;
}

/**
 * The list after opening `row` at `now`: its count is one more than before
 * (one if new), its time is now, and the whole list is re-ordered by
 * frecency and cut to `max` — so the least useful entry is the one that
 * falls off. Pure; self-contained apart from `frecencyOrder`.
 */
export function recordUse(
  uses: readonly PaletteUse[],
  row: { t: string; h: string; g: string },
  now: number,
  max: number,
): PaletteUse[] {
  const prev = uses.find((x) => x.h === row.h);
  const entry: PaletteUse = { t: row.t, h: row.h, g: row.g, c: (prev ? prev.c : 0) + 1, l: now };
  return frecencyOrder([entry].concat(uses.filter((x) => x.h !== row.h)), now).slice(0, max);
}

/**
 * The functions above as the JavaScript the page runs: Bun transpiles
 * this module before it ever parses it, so `toString` is already the
 * browser's dialect. A test proves the string and the module agree.
 */
export const paletteHelpersJs = `${fuzzyScore.toString()}\n${rankPalette.toString()}\n${opensAsSheet.toString()}\n${frecencyOrder.toString()}\n${readUses.toString()}\n${recordUse.toString()}`;
