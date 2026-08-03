/**
 * Markdown, the readable subset: headings, paragraphs, fenced code, lists,
 * quotes, and inline emphasis/code/links. Input is escaped before any
 * transformation, so the renderer cannot be talked into emitting markup.
 * CommonMark completeness is a non-goal — READMEs and issue prose are.
 */

import { escapeHtml, Html, raw } from "./html.ts";

function inline(escaped: string): string {
  return (
    escaped
      // `code` first, so nothing inside it is styled
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|\W)\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
      // [text](url) — safe schemes only; quotes are already escaped away
      .replace(
        /\[([^\]]+)\]\(([^)\s]+)\)/g,
        (match, text: string, url: string) => {
          // Protocol-relative "//host" escapes to another origin — reject it
          // alongside javascript:/data:. Allow absolute-http, rooted, anchor,
          // and explicitly-relative links only.
          if (url.startsWith("//")) return match;
          if (/^(https?:\/\/|\/|#|\.\/|\.\.\/)/.test(url)) {
            return `<a href="${url}" rel="nofollow noopener">${text}</a>`;
          }
          return match;
        },
      )
  );
}

export function renderMarkdown(source: string): Html {
  const lines = escapeHtml(source.replaceAll("\r\n", "\n")).split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: "ul" | "ol" | null = null;
  let quote = false;
  let fence = false;

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
  const closeBlocks = () => {
    closeParagraph();
    closeList();
    closeQuote();
  };

  for (const line of lines) {
    if (fence) {
      if (line.startsWith("```")) {
        out.push("</code></pre>");
        fence = false;
      } else {
        out.push(line);
      }
      continue;
    }
    if (line.startsWith("```")) {
      closeBlocks();
      fence = true;
      out.push("<pre><code>");
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

  if (fence) out.push("</code></pre>");
  closeBlocks();
  return raw(out.join("\n"));
}
