/**
 * Markdown → styled lines. Line-oriented, not an AST: block type comes from a
 * leading pattern, and a fenced code block is a mode flag that suppresses all
 * inline parsing. That one rule kills most markdown-renderer bugs.
 *
 * Syntax highlighting inside fences reuses `web/highlight.ts`, so a snippet
 * in a README is coloured identically in the browser and the terminal.
 *
 * Deliberately unsupported: nested blockquotes, reference links, footnotes,
 * HTML passthrough (shown literally — safer for untrusted READMEs), images
 * (alt text only), setext headings.
 */

import {
  detectLanguage,
  highlightLines,
  type Language,
} from "../../web/highlight.ts";
import { G, type Span } from "../term/screen.ts";
import {
  BOLD,
  DIM,
  ITALIC,
  STRIKE,
  UNDERLINE,
  style,
  type Style,
} from "../term/style.ts";
import { displayWidth, expandTabs, pad, wrap } from "../term/width.ts";
import type { Tokens } from "./theme.ts";

export type Line = Span[];

export function renderMarkdown(src: string, width: number, c: Tokens): Line[] {
  const out: Line[] = [];
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const body = style(c.fg, c.bg);
  let para: string[] = [];

  const flushParagraph = (): void => {
    if (para.length === 0) return;
    const spans = inline(para.join(" "), c, body);
    for (const l of wrapSpans(spans, width)) out.push(l);
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;

    const fence = raw.match(/^\s*```+\s*([\w+-]*)\s*$/);
    if (fence) {
      flushParagraph();
      const lang = languageOf(fence[1] ?? "");
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```+\s*$/.test(lines[i]!)) {
        code.push(lines[i]!);
        i++;
      }
      for (const l of renderCode(code, lang, width, c)) out.push(l);
      continue;
    }

    if (raw.trim() === "") {
      flushParagraph();
      out.push([]);
      continue;
    }

    if (/^\s*([*_-])\s*\1\s*\1[\s*_-]*$/.test(raw)) {
      flushParagraph();
      out.push([
        { text: G.h.repeat(Math.max(0, width)), style: style(c.border, c.bg) },
      ]);
      continue;
    }

    const heading = raw.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      const level = heading[1]!.length;
      const st =
        level === 1
          ? style(c.fg, c.bg, BOLD)
          : level === 2
            ? style(c.fg, c.bg, BOLD)
            : style(c.mutedFg, c.bg, BOLD);
      for (const l of wrapSpans(inline(heading[2]!, c, st), width)) out.push(l);
      if (level === 1)
        out.push([
          {
            text: G.h.repeat(Math.max(0, width)),
            style: style(c.border, c.bg),
          },
        ]);
      continue;
    }

    const quote = raw.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      const st = style(c.mutedFg, c.bg, ITALIC);
      for (const l of wrapSpans(
        inline(quote[1]!, c, st),
        Math.max(1, width - 2),
      ))
        out.push([{ text: `${G.v} `, style: style(c.border, c.bg) }, ...l]);
      continue;
    }

    const bullet = raw.match(/^(\s*)[-*+]\s+(.*)$/);
    const numbered = raw.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushParagraph();
      const indent =
        (bullet?.[1] ?? numbered?.[1] ?? "").length >= 2 ? "  " : "";
      const marker = bullet ? `${G.caretRight} ` : `${numbered![2]}. `;
      const text = bullet ? bullet[2]! : numbered![3]!;
      const lead = indent + marker;
      const inner = Math.max(1, width - displayWidth(lead));
      wrapSpans(inline(text, c, body), inner).forEach((l, n) => {
        out.push([
          {
            text: n === 0 ? lead : " ".repeat(displayWidth(lead)),
            style: style(c.faint, c.bg),
          },
          ...l,
        ]);
      });
      continue;
    }

    para.push(raw.trim());
  }
  flushParagraph();
  return out;
}

function renderCode(
  code: string[],
  lang: Language,
  width: number,
  c: Tokens,
): Line[] {
  const bg = c.muted;
  const rows = highlightLines(code.map((l) => expandTabs(l)).join("\n"), lang);
  return rows.map((tokens) => {
    const spans: Span[] = [{ text: " ", style: style(c.mutedFg, bg) }];
    let used = 1;
    for (const t of tokens) {
      if (used >= width) break;
      spans.push({ text: t.text, style: style(c.tok[t.cls], bg) });
      used += displayWidth(t.text);
    }
    // Pad the whole row so the code block reads as one surface, not as
    // ragged tinted text.
    if (used < width)
      spans.push({
        text: " ".repeat(width - used),
        style: style(c.mutedFg, bg),
      });
    return spans;
  });
}

function languageOf(info: string): Language {
  const name = info.toLowerCase();
  const alias: Record<string, Language> = {
    typescript: "ts",
    tsx: "ts",
    js: "ts",
    javascript: "ts",
    py: "python",
    golang: "go",
    rs: "rust",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    yml: "yaml",
  };
  if (name in alias) return alias[name]!;
  return name === "" ? "plain" : detectLanguage(`x.${name}`);
}

/**
 * One left-to-right inline pass. Backticks are handled first and code spans
 * are never re-parsed, which is what stops `**` inside a code span from
 * turning into bold.
 */
export function inline(text: string, c: Tokens, base: Style): Span[] {
  const out: Span[] = [];
  let buf = "";
  const flush = (): void => {
    if (buf !== "") out.push({ text: buf, style: base });
    buf = "";
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "`") {
      const close = text.indexOf("`", i + 1);
      if (close > i) {
        flush();
        out.push({
          text: text.slice(i + 1, close),
          style: style(c.tok.string, c.muted),
        });
        i = close + 1;
        continue;
      }
    } else if (text.startsWith("**", i)) {
      const close = text.indexOf("**", i + 2);
      if (close > i) {
        flush();
        out.push({
          text: text.slice(i + 2, close),
          style: { ...base, attr: base.attr | BOLD },
        });
        i = close + 2;
        continue;
      }
    } else if (text.startsWith("~~", i)) {
      const close = text.indexOf("~~", i + 2);
      if (close > i) {
        flush();
        out.push({
          text: text.slice(i + 2, close),
          style: { ...base, attr: base.attr | STRIKE },
        });
        i = close + 2;
        continue;
      }
    } else if (ch === "*" || ch === "_") {
      const close = text.indexOf(ch, i + 1);
      if (close > i + 1) {
        flush();
        out.push({
          text: text.slice(i + 1, close),
          style: { ...base, attr: base.attr | ITALIC },
        });
        i = close + 1;
        continue;
      }
    } else if (ch === "[" || (ch === "!" && text[i + 1] === "[")) {
      const start = ch === "!" ? i + 1 : i;
      const mid = text.indexOf("](", start);
      const end = mid > start ? text.indexOf(")", mid) : -1;
      if (mid > start && end > mid) {
        flush();
        const label = text.slice(start + 1, mid);
        const url = text.slice(mid + 2, end);
        // Images print their alt text; links get accent + underline and the
        // URL trailing in dim, since a terminal has nowhere to hide an href.
        if (ch === "!")
          out.push({
            text: label,
            style: { ...base, attr: base.attr | ITALIC },
          });
        else {
          out.push({
            text: label,
            style: style(c.accent, base.bg, base.attr | UNDERLINE),
          });
          out.push({ text: ` ${url}`, style: style(c.faint, base.bg, DIM) });
        }
        i = end + 1;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

/**
 * Word wrap over styled runs, measuring the *plain* text. Miscounting escape
 * bytes as width is the single most common bug in ANSI markdown renderers,
 * which is why nothing here ever holds a pre-rendered escape string.
 */
export function wrapSpans(spans: readonly Span[], width: number): Line[] {
  if (width <= 0) return [[...spans]];
  const words: Span[] = [];
  for (const span of spans)
    for (const piece of span.text.split(/(\s+)/))
      if (piece !== "") words.push({ text: piece, style: span.style });

  const out: Line[] = [];
  let line: Span[] = [];
  let used = 0;
  for (const word of words) {
    const w = displayWidth(word.text);
    if (used + w > width && used > 0) {
      out.push(line);
      line = [];
      used = 0;
      if (/^\s+$/.test(word.text)) continue;
    }
    if (w > width) {
      // A single unbreakable word wider than the field: hard-split it rather
      // than let it overflow and wrap in the terminal.
      for (const chunk of wrap(word.text, width)) {
        if (used > 0) {
          out.push(line);
          line = [];
          used = 0;
        }
        line.push({ text: chunk, style: word.style });
        used = displayWidth(chunk);
      }
      continue;
    }
    line.push(word);
    used += w;
  }
  if (line.length > 0 || out.length === 0) out.push(line);
  return out;
}

/** Flatten a styled line to plain text padded to `width` — for snapshots. */
export function lineText(line: Line, width?: number): string {
  const text = line.map((s) => s.text).join("");
  return width === undefined ? text : pad(text, width);
}
