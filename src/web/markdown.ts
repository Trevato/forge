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

/**
 * Where a file lives, so its relative addresses can mean something: the
 * repository's base path (`/owner/name`), the ref as written in a URL, and the
 * directory the file is in (`""` for the root).
 */
export interface MarkdownRepo {
  readonly base: string;
  readonly ref: string;
  readonly dir: string;
}

const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i;

/**
 * A relative address resolved against the file's directory, inside the
 * repository only. `undefined` when it leaves the root, is not a plain path,
 * or is not relative at all (anchors, rooted paths stay as they were).
 */
function resolveRelative(
  escapedUrl: string,
  repo: MarkdownRepo,
): { path: string; tail: string; dir: boolean } | "inert" | undefined {
  if (escapedUrl === "" || escapedUrl.startsWith("#") || escapedUrl.startsWith("/")) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(escapedUrl)) return undefined;
  if (escapedUrl.includes("&") || escapedUrl.includes("\\")) return "inert";
  const cut = escapedUrl.search(/[?#]/);
  const pathPart = cut < 0 ? escapedUrl : escapedUrl.slice(0, cut);
  const tail = cut < 0 ? "" : escapedUrl.slice(cut);
  if (pathPart === "") return undefined;
  const parts: string[] = repo.dir === "" ? [] : repo.dir.split("/");
  const given = pathPart.split("/");
  for (const [i, raw] of given.entries()) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return "inert";
    }
    if (/[\x00-\x1f\x7f\\/]/.test(seg)) return "inert";
    if (seg === "" || seg === ".") {
      if (seg === "" && i !== given.length - 1) return "inert";
      continue;
    }
    if (seg === "..") {
      if (parts.length === 0) return "inert";
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  const path = parts.join("/");
  if (path.length > 4096) return "inert";
  const lastSlash = pathPart.endsWith("/") || pathPart.endsWith("/.") || pathPart.endsWith("/..");
  return { path, tail, dir: lastSlash || path === "" };
}

const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

function inline(escaped: string, repo?: MarkdownRepo): string {
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
  // Images first, so one inside a link's text (`[![badge](b.svg)](x.md)`) is
  // already an <img> when the link is read.
  return (
    text
      .replace(/(!)\[([^\]]+)\]\(([^)\s]+)\)/g, link)
      .replace(/()\[([^\]]+)\]\(([^)\s]+)\)/g, link)
  );
  // [text](url) — safe schemes only; quotes are already escaped away
  function link(match: string, bang: string, text: string, url: string): string {
        {
          if (bang === "!" && repo !== undefined) {
            // An image is only ever one of this repository's own files.
            const at = resolveRelative(url, repo);
            if (at !== undefined) {
              const alt = text.replace(/<\/?(?:code|strong|em)>/g, "");
              if (at === "inert" || at.dir || !IMAGE.test(at.path)) return alt;
              return `<img src="${repo.base}/media/${repo.ref}/${encodePath(at.path)}" alt="${alt}" loading="lazy">`;
            }
          }
          // Protocol-relative "//host" escapes to another origin — reject it,
          // and reject anything carrying a scheme other than http(s), which is
          // what keeps javascript:, data: and vbscript: out. What is left is a
          // relative path (`docs/keeping.md`), a rooted one, or an anchor —
          // all of which stay on this origin by construction.
          if (url.startsWith("//")) return match;
          if (repo !== undefined) {
            const at = resolveRelative(url, repo);
            if (at === "inert") return `${bang}${text}`;
            if (at !== undefined) {
              const route = at.dir ? "tree" : "blob";
              const target = at.path === "" ? `${repo.base}/tree/${repo.ref}` : `${repo.base}/${route}/${repo.ref}/${encodePath(at.path)}`;
              return `${bang}<a href="${target}${at.tail}" rel="nofollow noopener">${text}</a>`;
            }
          }
          // Browsers strip C0 controls before reading a scheme, so
          // "\u0001javascript:" is javascript: to them and no scheme to the
          // test below — refuse any control character outright.
          if (/[\u0000-\u001f\u007f-\u009f]/.test(url)) return match;
          const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url);
          if (scheme && !/^https?$/i.test(scheme[1]!)) return match;
          return `${bang}<a href="${url}" rel="nofollow noopener">${text}</a>`;
        }
  }
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
function cells(line: string, align: string[], tag: "th" | "td", repo?: MarkdownRepo): string {
  return splitRow(line)
    .map((cell, i) => {
      const a = align[i];
      const attr = a === "c" || a === "r" ? ` class="ta-${a}"` : "";
      return `<${tag}${attr}>${inline(cell, repo)}</${tag}>`;
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

const taskCounts = new WeakMap<Html, { done: number; total: number }>();

/** The `- [ ]` / `- [x]` items a rendering drew; `undefined` when it drew none. */
export function markdownTasks(rendered: Html): { done: number; total: number } | undefined {
  return taskCounts.get(rendered);
}

export function renderMarkdown(source: string, repo?: MarkdownRepo): Html {
  if (source.length > MEMO_MAX_SOURCE) return renderUncached(source, repo);
  const key = repo === undefined ? source : `${repo.base}\0${repo.ref}\0${repo.dir}\0\0${source}`;
  const hit = memo.get(key);
  if (hit !== undefined) {
    // Re-insert so the Map's order is recency: the oldest key is the first.
    memo.delete(key);
    memo.set(key, hit);
    counts.hits++;
    return hit;
  }
  counts.misses++;
  const made = renderUncached(source, repo);
  if (memo.size >= MEMO_MAX) {
    const oldest = memo.keys().next();
    if (!oldest.done) memo.delete(oldest.value);
  }
  memo.set(key, made);
  return made;
}

function renderUncached(source: string, repo?: MarkdownRepo): Html {
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
  const tasks = { done: 0, total: 0 };

  const closeParagraph = () => {
    if (paragraph.length > 0) {
      out.push(`<p>${inline(paragraph.join("\n"), repo)}</p>`);
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
      out.push("</tbody></table></div>");
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
        out.push(`<tr>${cells(line, align, "td", repo)}</tr>`);
        continue;
      }
      closeTable();
    } else if (isTableRow(line) && isDelimiterRow(lines[index + 1] ?? "")) {
      closeBlocks();
      align = alignments(lines[index + 1]!);
      out.push(`<div class="table-scroll" role="region" aria-label="Table" tabindex="0"><table><thead><tr>${cells(line, align, "th", repo)}</tr></thead>`);
      out.push("<tbody>");
      skip = index + 1;
      continue;
    }

    const heading = line.match(/^(#{1,6}) +(.*)$/);
    if (heading) {
      closeBlocks();
      const level = heading[1]!.length;
      out.push(`<h${level}>${inline(heading[2]!, repo)}</h${level}>`);
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
      const item = (bullet ?? numbered)![1]!;
      const task = bullet ? /^\[([ xX])\] +(\S.*)$/.exec(item) : null;
      if (task !== null) {
        const ticked = task[1] !== " ";
        tasks.total++;
        if (ticked) tasks.done++;
        out.push(
          `<li class="task"><label><input type="checkbox" disabled${ticked ? " checked" : ""}> ${inline(task[2]!, repo)}</label></li>`,
        );
      } else {
        out.push(`<li>${inline(item, repo)}</li>`);
      }
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
      out.push(`<p>${inline(quoted[1]!, repo)}</p>`);
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
  const made = raw(out.join("\n"));
  if (tasks.total > 0) taskCounts.set(made, tasks);
  return made;
}
