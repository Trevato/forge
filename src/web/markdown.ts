/**
 * Markdown, the readable subset: headings, paragraphs, fenced code, lists,
 * quotes, and inline emphasis/code/links. Input is escaped before any
 * transformation, so the renderer cannot be talked into emitting markup.
 * CommonMark completeness is a non-goal — READMEs and issue prose are.
 *
 * A fold (`<details><summary>Title</summary>` … `</details>`, each on a line
 * of its own) is the one other tag it emits, with a title it checks.
 *
 * A fence with an info string is handed to the tokenizer, so the code samples
 * in a README read as code. That is the one place this renderer emits markup
 * it did not escape itself, and it is safe for the same reason the file
 * browser is: the tokenizer is lossless over its input and every token's text
 * is escaped on the way out, so a fence can produce spans and nothing else.
 */

import { languageFromName, type Language } from "./highlight.ts";
import { highlightToHtml } from "./highlight-html.ts";
import { escapeHtml, Html, raw } from "./html.ts";

function inline(escaped: string): string {
  // Most lines of prose carry none of the marks; each rule only runs on a
  // line that has the character it starts with, which changes nothing about
  // what the rules produce.
  let text = escaped;
  // `code` first, so nothing inside it is styled
  if (text.includes("`")) text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
  if (text.includes("*")) {
    text = text
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|\W)\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  }
  if (!text.includes("](")) return text;
  return (
    text
      // [text](url) — safe schemes only; quotes are already escaped away
      .replace(
        /\[([^\]]+)\]\(([^)\s]+)\)/g,
        (match, text: string, url: string) => {
          // Protocol-relative "//host" escapes to another origin — reject it,
          // and reject anything carrying a scheme other than http(s), which is
          // what keeps javascript:, data: and vbscript: out. What is left is a
          // relative path (`docs/keeping.md`), a rooted one, or an anchor —
          // all of which stay on this origin by construction.
          if (url.startsWith("//")) return match;
          // Browsers strip C0 controls before reading a scheme, so
          // "\u0001javascript:" is javascript: to them and no scheme to the
          // test below — refuse any control character outright.
          if (/[\u0000-\u001f\u007f-\u009f]/.test(url)) return match;
          const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url);
          if (scheme && !/^https?$/i.test(scheme[1]!)) return match;
          return `<a href="${url}" rel="nofollow noopener">${text}</a>`;
        },
      )
  );
}

/**
 * A fenced block, opening tag and all, as one chunk — the whole block is one
 * entry in `out` so the newline that joins entries never lands inside a `pre`,
 * where it would show up as a blank first line.
 */
function closeFence(body: string[], lang: Language): string {
  const code =
    lang === "plain"
      ? escapeHtml(body.join("\n"))
      : highlightToHtml(body.join("\n"), lang);
  const open =
    lang === "plain" ? "<pre><code>" : `<pre><code class="language-${lang}">`;
  return `${open}${code}</code></pre>`;
}

const isTableRow = (line: string): boolean => /^\s*\|.*\|\s*$/.test(line);

const isDelimiterRow = (line: string): boolean =>
  /^\s*\|(\s*:?-{1,}:?\s*\|)+\s*$/.test(line);

/** The alignment of each column, from the delimiter row's colons. */
function alignments(delimiter: string): string[] {
  return splitRow(delimiter).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    return right ? (left ? "c" : "r") : "";
  });
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

/** One row's cells, inline-rendered, aligned as the delimiter row asked. */
function cells(line: string, align: string[], tag: "th" | "td"): string {
  return splitRow(line)
    .map((cell, i) => {
      const a = align[i];
      const attr = a === "c" || a === "r" ? ` class="ta-${a}"` : "";
      return `<${tag}${attr}>${inline(cell)}</${tag}>`;
    })
    .join("");
}

/**
 * Rendering is a pure function of the source, and a thread is drawn again on
 * every visit and every live append, so the last few hundred results are kept.
 * The value is the same `Html` the first render produced, so output is
 * byte-identical; only the work is skipped.
 */
const MEMO_MAX = 512;
const MEMO_MAX_SOURCE = 20_000;
const memo = new Map<string, Html>();
const counts = { hits: 0, misses: 0 };
let worked = 0;

/** How many times the markdown was actually parsed, memo or no memo. */
export const markdownWorkDone = (): number => worked;

/** How often a render was remembered or made; for tests to assert the memo works. */
export function markdownMemoStats(): { hits: number; misses: number } {
  return { ...counts };
}

export function renderMarkdown(source: string): Html {
  if (source.length > MEMO_MAX_SOURCE) return renderUncached(source);
  const hit = memo.get(source);
  if (hit !== undefined) {
    // Re-insert so the Map's order is recency: the oldest key is the first.
    memo.delete(source);
    memo.set(source, hit);
    counts.hits++;
    return hit;
  }
  counts.misses++;
  const made = renderUncached(source);
  if (memo.size >= MEMO_MAX) {
    const oldest = memo.keys().next();
    if (!oldest.done) memo.delete(oldest.value);
  }
  memo.set(source, made);
  return made;
}

function renderUncached(source: string): Html {
  worked++;
  const text = source.replaceAll("\r\n", "\n");
  // Escaping does not move a newline, so the two arrays stay in step: `lines`
  // is what prose is built from, `raws` is what the tokenizer needs.
  const lines = escapeHtml(text).split("\n");
  const raws = text.split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: "ul" | "ol" | null = null;
  let quote = false;
  let fence = false;
  let fenceLang: Language = "plain";
  let fenceWidth = 3;
  let body: string[] = [];
  let align: string[] | null = null;
  let skip = -1;
  let folded = false;

  const closeParagraph = () => {
    if (paragraph.length > 0) {
      out.push(`<p>${inline(paragraph.join("\n"))}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  const closeQuote = () => {
    if (quote) {
      out.push("</blockquote>");
      quote = false;
    }
  };
  const closeTable = () => {
    if (align) {
      out.push("</tbody></table>");
      align = null;
    }
  };
  const closeBlocks = () => {
    closeParagraph();
    closeList();
    closeQuote();
    closeTable();
  };

  for (const [index, line] of lines.entries()) {
    // The delimiter row was consumed with the header it belongs to.
    if (index === skip) continue;
    if (fence) {
      // CommonMark: only a line of backticks at least as long as the
      // opening, and nothing else, closes it — so a block fenced with more
      // backticks than its text holds cannot be closed from inside.
      const closing = /^(`{3,})\s*$/.exec(line);
      if (closing !== null && (closing[1] ?? "").length >= fenceWidth) {
        out.push(closeFence(body, fenceLang));
        body = [];
        fence = false;
      } else {
        body.push(raws[index] ?? "");
      }
      continue;
    }
    if (line.startsWith("```")) {
      closeBlocks();
      fence = true;
      fenceWidth = /^`+/.exec(line)?.[0].length ?? 3;
      body = [];
      fenceLang = languageFromName((raws[index] ?? "").slice(fenceWidth));
      continue;
    }

    // A fold: `<details><summary>Title</summary>` on a line of its own, then
    // `</details>`. The title is escaped text; nothing else opens a tag.
    const fold = /^<details><summary>([^<>&"'`]{1,80})<\/summary>$/.exec(raws[index] ?? "");
    if (fold !== null && !folded) {
      closeBlocks();
      out.push(`<details><summary>${fold[1]}</summary>`);
      folded = true;
      continue;
    }
    if (folded && raws[index] === "</details>") {
      closeBlocks();
      out.push("</details>");
      folded = false;
      continue;
    }

    // A table: a row of pipes over a row of dashes. Both halves have to be
    // there — a lone line with a pipe in it is a sentence, not a table.
    if (align) {
      if (isTableRow(line)) {
        out.push(`<tr>${cells(line, align, "td")}</tr>`);
        continue;
      }
      closeTable();
    } else if (isTableRow(line) && isDelimiterRow(lines[index + 1] ?? "")) {
      closeBlocks();
      align = alignments(lines[index + 1]!);
      out.push(`<table><thead><tr>${cells(line, align, "th")}</tr></thead>`);
      out.push("<tbody>");
      skip = index + 1;
      continue;
    }

    const heading = line.match(/^(#{1,6}) +(.*)$/);
    if (heading) {
      closeBlocks();
      const level = heading[1]!.length;
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      continue;
    }

    const bullet = line.match(/^[-*] +(.*)$/);
    const numbered = line.match(/^\d+\. +(.*)$/);
    if (bullet || numbered) {
      closeParagraph();
      closeQuote();
      const kind = bullet ? "ul" : "ol";
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline((bullet ?? numbered)![1]!)}</li>`);
      continue;
    }

    const quoted = line.match(/^&gt; ?(.*)$/);
    if (quoted) {
      closeParagraph();
      closeList();
      if (!quote) {
        out.push("<blockquote>");
        quote = true;
      }
      out.push(`<p>${inline(quoted[1]!)}</p>`);
      continue;
    }

    if (line.trim() === "") {
      closeBlocks();
      continue;
    }
    closeList();
    closeQuote();
    paragraph.push(line);
  }

  if (fence) out.push(closeFence(body, fenceLang));
  closeBlocks();
  if (folded) out.push("</details>");
  return raw(out.join("\n"));
}
