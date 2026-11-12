/**
 * The table rows of a highlighted file: plain data in, one string out. The
 * page builds them inline for a warm read and in a worker (`code_rows_pool.ts`)
 * for a cold one, from this one function, so the markup is the same either way.
 */
import { countLines, highlightPrefix } from "./code.ts";
import { html, type Html } from "./html.ts";

/** What a file page draws of a text file. */
export interface CodeRows {
  /** Lines in the whole file. */
  readonly total: number;
  /** Lines drawn (the first `limit`). */
  readonly shown: number;
  /** The `<tr>` rows, already escaped. */
  readonly rows: string;
}

/** One `<tr>` per highlighted line, numbered from 1. */
export function rowsMarkup(lines: readonly Html[]): string {
  return lines
    .map((line, i) => html`<tr id="L${i + 1}"><td class="ln"><a href="#L${i + 1}">${i + 1}</a></td><td><pre>${line}</pre></td></tr>`.text)
    .join("");
}

/** The first `limit` lines of `text` highlighted for `path`, as rows. */
export function codeRows(text: string, path: string, limit: number): CodeRows {
  const lines = highlightPrefix(text, path, limit);
  return { total: countLines(text), shown: lines.length, rows: rowsMarkup(lines) };
}
