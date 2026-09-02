/**
 * One display-width function, used by wrapping, truncation, alignment, the
 * cell buffer and borders alike. Every width bug in the prior art (lipgloss's
 * retracted v0.11.1 among them) traces to a codebase having more than one.
 *
 * Widths matter most at the right edge: a width-2 glyph with one column left
 * must not be split, because a terminal that half-prints one corrupts both
 * cells and every subsequent column on the row. So we measure by *grapheme
 * cluster* — segment first, then width — never by summing codepoints, which
 * gets NFD "é" and every flag wrong.
 */

import { stripAnsi } from "./ansi.ts";

// East Asian Wide + Fullwidth, as flat [start, end, …] pairs (UAX #11). Data,
// not a dependency: a few hundred bytes covering essentially all real content.
const WIDE = new Uint32Array([
  0x1100, 0x115f, 0x2e80, 0x303e, 0x3041, 0x33ff, 0x3400, 0x4dbf, 0x4e00,
  0x9fff, 0xa000, 0xa4cf, 0xa960, 0xa97f, 0xac00, 0xd7a3, 0xf900, 0xfaff,
  0xfe10, 0xfe19, 0xfe30, 0xfe6f, 0xff00, 0xff60, 0xffe0, 0xffe6, 0x1f1e6,
  0x1f1ff, 0x1f300, 0x1f64f, 0x1f680, 0x1f6ff, 0x1f900, 0x1f9ff, 0x1fa70,
  0x1faff, 0x20000, 0x2fffd, 0x30000, 0x3fffd,
]);

// Combining marks, format characters and variation selectors: width 0. The
// Hangul fillers U+1160–11FF must be 0, not 2 — they compose onto a preceding
// jamo and adding 2 there double-counts every decomposed Hangul syllable.
const ZERO = new Uint32Array([
  0x0300, 0x036f, 0x0483, 0x0489, 0x0591, 0x05bd, 0x0610, 0x061a, 0x064b,
  0x065f, 0x0670, 0x0670, 0x06d6, 0x06dc, 0x0e31, 0x0e31, 0x0e34, 0x0e3a,
  0x0e47, 0x0e4e, 0x1160, 0x11ff, 0x200b, 0x200f, 0x2060, 0x2064, 0xfe00,
  0xfe0f, 0xfe20, 0xfe2f, 0xfeff, 0xfeff, 0xe0000, 0xe007f, 0xe0100, 0xe01ef,
]);

function inRanges(table: Uint32Array, cp: number): boolean {
  if (cp < table[0]! || cp > table[table.length - 1]!) return false;
  let lo = 0;
  let hi = table.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < table[mid * 2]!) hi = mid - 1;
    else if (cp > table[mid * 2 + 1]!) lo = mid + 1;
    else return true;
  }
  return false;
}

let segmenter: Intl.Segmenter | undefined;
function graphemes(s: string): Intl.Segments {
  // Constructing a Segmenter is expensive; one per process is plenty.
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return segmenter.segment(s);
}

/** Split into grapheme clusters — the unit a terminal cell can hold. */
export function clusters(s: string): string[] {
  if (s === "") return [];
  if (isAscii(s)) return s.split("");
  const out: string[] = [];
  for (const seg of graphemes(s)) out.push(seg.segment);
  return out;
}

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

const widthCache = new Map<string, number>();

/**
 * Width of a single grapheme cluster: 0, 1 or 2.
 *
 * Rule (UTS #51 as far as it can be honoured from an application): width the
 * cluster by its first non-zero-width codepoint, then apply the VS16 bump —
 * U+FE0F requests emoji presentation, which every terminal renders 2 wide.
 */
export function clusterWidth(cluster: string): number {
  const cached = widthCache.get(cluster);
  if (cached !== undefined) return cached;
  const w = computeClusterWidth(cluster);
  // Cap the cache: user content can contain unbounded distinct clusters.
  if (widthCache.size > 4096) widthCache.clear();
  widthCache.set(cluster, w);
  return w;
}

function computeClusterWidth(cluster: string): number {
  if (cluster === "") return 0;
  if (cluster.includes("\u{FE0F}")) return 2; // VS16: emoji presentation
  if (cluster.includes("\u{FE0E}")) return 1; // VS15: text presentation
  if (cluster.includes("\u{200D}")) return 2; // ZWJ sequence: one wide glyph
  for (const ch of cluster) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0; // C0/C1: never printed
    if (inRanges(ZERO, cp)) continue;
    if (inRanges(WIDE, cp)) return 2;
    return 1;
  }
  return 0;
}

/** Columns `s` occupies. Escape sequences are stripped, not measured. */
export function displayWidth(s: string): number {
  if (s === "") return 0;
  if (isAscii(s)) return s.length; // >95% of forge content
  const plain = s.includes("\x1b") ? stripAnsi(s) : s;
  let w = 0;
  for (const seg of graphemes(plain)) w += clusterWidth(seg.segment);
  return w;
}

/** Literal tabs destroy every column calculation; expand once at the edge. */
export function expandTabs(s: string, tabSize = 4): string {
  if (!s.includes("\t")) return s;
  let out = "";
  let col = 0;
  for (const cluster of clusters(s)) {
    if (cluster === "\t") {
      const n = tabSize - (col % tabSize);
      out += " ".repeat(n);
      col += n;
    } else {
      out += cluster;
      col += clusterWidth(cluster);
    }
  }
  return out;
}

/** Cut to at most `width` columns, appending `ellipsis` when it had to cut. */
export function truncate(s: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  if (displayWidth(s) <= width) return s;
  const mark = displayWidth(ellipsis);
  const budget = width - mark;
  if (budget <= 0) return ellipsis.slice(0, width);
  let out = "";
  let w = 0;
  for (const cluster of clusters(s)) {
    const cw = clusterWidth(cluster);
    if (w + cw > budget) break;
    out += cluster;
    w += cw;
  }
  return out + ellipsis;
}

/** Pad to `width` columns. Never `padEnd` — that counts UTF-16 code units. */
export function pad(s: string, width: number, align: Align = "left"): string {
  const gap = width - displayWidth(s);
  if (gap <= 0) return s;
  if (align === "right") return " ".repeat(gap) + s;
  if (align === "center") {
    const left = gap >> 1;
    return " ".repeat(left) + s + " ".repeat(gap - left);
  }
  return s + " ".repeat(gap);
}

export type Align = "left" | "right" | "center";

/**
 * Greedy word wrap on plain text, measured in columns. A single word wider
 * than the field is hard-split by cluster rather than allowed to overflow —
 * an overflowing line is worse than an ugly break, because it wraps in the
 * terminal and desynchronises every row below it.
 */
export function wrap(s: string, width: number): string[] {
  if (width <= 0) return [s];
  const out: string[] = [];
  for (const paragraph of s.split("\n")) {
    if (paragraph === "") {
      out.push("");
      continue;
    }
    let line = "";
    let lineW = 0;
    for (const word of paragraph.split(/(\s+)/)) {
      if (word === "") continue;
      const ww = displayWidth(word);
      if (lineW > 0 && lineW + ww > width) {
        if (/^\s+$/.test(word)) {
          out.push(line);
          line = "";
          lineW = 0;
          continue;
        }
        out.push(line);
        line = "";
        lineW = 0;
      }
      if (ww > width) {
        for (const piece of hardSplit(word, width, line, lineW)) {
          if (piece.done) out.push(piece.text);
          else {
            line = piece.text;
            lineW = displayWidth(line);
          }
        }
        continue;
      }
      line += word;
      lineW += ww;
    }
    out.push(line);
  }
  return out;
}

function hardSplit(
  word: string,
  width: number,
  seed: string,
  seedW: number,
): { text: string; done: boolean }[] {
  const out: { text: string; done: boolean }[] = [];
  let line = seed;
  let w = seedW;
  for (const cluster of clusters(word)) {
    const cw = clusterWidth(cluster);
    if (w + cw > width) {
      out.push({ text: line, done: true });
      line = "";
      w = 0;
    }
    line += cluster;
    w += cw;
  }
  out.push({ text: line, done: false });
  return out;
}
