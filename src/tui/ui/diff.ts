/**
 * A `Diff` → styled lines, following delta's key insight and the web diff
 * view's compose rule exactly: **background carries add/delete, foreground
 * carries syntax**, and an intra-line change gets the stronger `wd-add` /
 * `wd-del` tint on top. The word-level segments come from `web/worddiff.ts`,
 * so the browser and the terminal highlight character-for-character the same
 * spans — which is the entire point of sharing the module.
 *
 * The raw `@@` header is replaced by the location a reviewer actually wants:
 * path, new-side line number, and the enclosing section git found.
 */

import type { Diff, DiffLine, FileDiff, Hunk } from "../../git/diff.ts";
import {
  detectLanguage,
  highlightLines,
  type Token,
} from "../../web/highlight.ts";
import { wordDiff } from "../../web/worddiff.ts";
import { G, type Span } from "../term/screen.ts";
import { BOLD, DIM, style, type Color, type Style } from "../term/style.ts";
import { displayWidth, expandTabs, pad, truncate } from "../term/width.ts";
import type { Tokens } from "./theme.ts";

export type Line = Span[];

const GUTTER = 10; // "  123 456 " — two numbers plus the marker column

export function renderDiff(diff: Diff, width: number, c: Tokens): Line[] {
  const out: Line[] = [];
  diff.files.forEach((file, i) => {
    if (i > 0) out.push([]);
    for (const line of renderFileDiff(file, width, c)) out.push(line);
  });
  return out;
}

export function renderFileDiff(
  file: FileDiff,
  width: number,
  c: Tokens,
): Line[] {
  const out: Line[] = [fileHeader(file, width, c)];
  if (file.binary) {
    out.push([
      { text: "  Binary file not shown", style: style(c.faint, c.bg, DIM) },
    ]);
    return out;
  }
  const lang = detectLanguage(file.path);
  for (const hunk of file.hunks) {
    out.push(hunkHeader(file, hunk, width, c));
    for (const line of renderHunk(hunk, lang, width, c)) out.push(line);
  }
  return out;
}

const STATUS_TONE: Record<FileDiff["status"], (c: Tokens) => Color> = {
  added: (c) => c.success,
  deleted: (c) => c.danger,
  modified: (c) => c.accent,
  renamed: (c) => c.merged,
  copied: (c) => c.merged,
};

function fileHeader(file: FileDiff, width: number, c: Tokens): Line {
  const tone = STATUS_TONE[file.status](c);
  const counts = `+${file.additions} -${file.deletions}`;
  const path =
    file.status === "renamed" && file.oldPath !== null
      ? `${file.oldPath} ${G.chevron} ${file.path}`
      : file.path;
  const room = Math.max(0, width - displayWidth(counts) - 4);
  const spans: Line = [
    { text: `${G.caretDown} `, style: style(tone, c.muted) },
    { text: truncate(path, room), style: style(c.fg, c.muted, BOLD) },
  ];
  const used = 2 + displayWidth(truncate(path, room));
  const gap = Math.max(1, width - used - displayWidth(counts) - 1);
  spans.push({ text: " ".repeat(gap), style: style(c.fg, c.muted) });
  spans.push({ text: `+${file.additions} `, style: style(c.addFg, c.muted) });
  spans.push({ text: `-${file.deletions} `, style: style(c.delFg, c.muted) });
  return spans;
}

function hunkHeader(
  file: FileDiff,
  hunk: Hunk,
  width: number,
  c: Tokens,
): Line {
  const where = `${file.path}:${hunk.newStart}`;
  const section = hunk.section === "" ? "" : `  ${hunk.section}`;
  const text = ` ${where}${section}`;
  return [
    {
      text: pad(truncate(text, width), width),
      style: style(c.mutedFg, c.muted, DIM),
    },
  ];
}

interface Painted {
  readonly content: string;
  /** Per-cluster background override from the word diff, or -1. */
  readonly marks: Int32Array;
}

function renderHunk(
  hunk: Hunk,
  lang: ReturnType<typeof detectLanguage>,
  width: number,
  c: Tokens,
): Line[] {
  // Expand tabs once, here: a literal tab destroys the gutter alignment for
  // every row below it, and no downstream code can recover the intent.
  const contents = hunk.lines.map((l) => expandTabs(l.content));
  // Highlight the hunk as one document so a multi-line string or comment
  // keeps its state across rows.
  const tokens = highlightLines(contents.join("\n"), lang);
  const marks = pairWordDiffs(hunk.lines, contents);

  return hunk.lines.map((line, i) => {
    const painted: Painted = {
      content: contents[i] ?? "",
      marks: marks[i] ?? new Int32Array(0),
    };
    return renderLine(line, painted, tokens[i] ?? [], width, c);
  });
}

/**
 * delta's pairing heuristic: a run of deletions immediately followed by an
 * equal-length run of additions is a rewrite, so pair them index-wise and
 * word-diff each pair. Anything else is a plain add or delete.
 */
function pairWordDiffs(
  lines: readonly DiffLine[],
  contents: readonly string[],
): Int32Array[] {
  const out: Int32Array[] = lines.map((_, i) =>
    new Int32Array([...(contents[i] ?? "")].length).fill(0),
  );
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.kind !== "del") {
      i++;
      continue;
    }
    let delEnd = i;
    while (delEnd < lines.length && lines[delEnd]!.kind === "del") delEnd++;
    let addEnd = delEnd;
    while (addEnd < lines.length && lines[addEnd]!.kind === "add") addEnd++;
    const dels = delEnd - i;
    const adds = addEnd - delEnd;
    if (dels > 0 && dels === adds) {
      for (let k = 0; k < dels; k++) {
        const wd = wordDiff(contents[i + k] ?? "", contents[delEnd + k] ?? "");
        out[i + k] = markArray(wd.old);
        out[delEnd + k] = markArray(wd.new);
      }
    }
    i = addEnd > i ? addEnd : i + 1;
  }
  return out;
}

function markArray(
  segments: readonly { text: string; changed: boolean }[],
): Int32Array {
  const chars: number[] = [];
  for (const seg of segments)
    for (const _ of seg.text) chars.push(seg.changed ? 1 : 0);
  return Int32Array.from(chars);
}

function renderLine(
  line: DiffLine,
  painted: Painted,
  tokens: readonly Token[],
  width: number,
  c: Tokens,
): Line {
  const base =
    line.kind === "add" ? c.addBg : line.kind === "del" ? c.delBg : c.bg;
  const edge =
    line.kind === "add" ? c.addFg : line.kind === "del" ? c.delFg : c.faint;
  const wd = line.kind === "add" ? c.wdAdd : c.wdDel;
  const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";

  const gutter: Line = [
    {
      text: `${num(line.oldNumber)} ${num(line.newNumber)}`,
      style: style(c.faint, base, DIM),
    },
    { text: marker, style: style(edge, base, BOLD) },
  ];

  const body = Math.max(0, width - GUTTER);
  const spans: Line = [...gutter];
  let used = 0;
  let charIndex = 0;
  for (const token of tokens) {
    const fg = c.tok[token.cls] ?? c.fg;
    // Split each syntax token wherever the word-diff background changes:
    // syntax owns the foreground, the diff owns the background, and the two
    // are resolved independently exactly as the web stylesheet composes them.
    let run = "";
    let runBg = bgAt(painted, charIndex, base, wd);
    for (const ch of token.text) {
      const b = bgAt(painted, charIndex, base, wd);
      if (b !== runBg && run !== "") {
        used = push(spans, run, style(fg, runBg), used, body);
        run = "";
      }
      runBg = b;
      run += ch;
      charIndex++;
    }
    if (run !== "") used = push(spans, run, style(fg, runBg), used, body);
    if (used >= body) break;
  }
  if (used < body)
    spans.push({ text: " ".repeat(body - used), style: style(c.fg, base) });
  if (line.noNewline)
    spans.push({ text: " no newline", style: style(c.faint, base, DIM) });
  return spans;
}

function bgAt(p: Painted, i: number, base: Color, wd: Color): Color {
  return p.marks[i] === 1 ? wd : base;
}

function push(
  spans: Line,
  text: string,
  st: Style,
  used: number,
  body: number,
): number {
  const room = body - used;
  if (room <= 0) return used;
  const cut = truncate(text, room, "");
  spans.push({ text: cut, style: st });
  return used + displayWidth(cut);
}

function num(n: number | null): string {
  return n === null ? "    " : pad(String(n), 4, "right");
}
