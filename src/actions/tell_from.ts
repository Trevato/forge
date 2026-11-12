/**
 * Where a tell was said: the one rule for `from`, pure, so the CLI refuses
 * what the server would before it spends a round trip.
 */

import { scrubQuery } from "./tell_context.ts";

/** The most characters a tell's words may have; every door refuses more. */
export const TELL_TEXT_MAX = 2000;

/** The longest `from` a tell may carry. */
export const FROM_MAX = 512;

/**
 * `from` as the doors take it: absent is none; otherwise a same-forge path
 * (leading single `/`, no scheme, no backslash, no control or space) of at
 * most 512 characters. Undefined for no. A query parameter that carries a
 * secret (`scrubQuery`) is dropped; the rest of the path is kept as given.
 */
export function parseFrom(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > FROM_MAX)
    return undefined;
  if (!raw.startsWith("/") || raw.startsWith("//")) return undefined;
  if (/[\\\s\x00-\x1f\x7f<>()\[\]`"'*]/.test(raw)) return undefined;
  const q = raw.indexOf("?");
  const h = raw.indexOf("#");
  if (q === -1 || (h !== -1 && h < q)) return raw;
  const end = h === -1 ? raw.length : h;
  return `${raw.slice(0, q)}${scrubQuery(raw.slice(q, end))}${raw.slice(end)}`;
}

/**
 * The plain line a tell from a preview's toolbar opens its issue with:
 * "from preview of #N, page /x". The path is only the path of the page the
 * person was on (never its host, query or fragment), with every character
 * `parseFrom` refuses percent-encoded, so it cannot become markup. It is
 * context for a reader, never authority: nothing is granted by it.
 * Empty when there is no pull or no usable page.
 */
export function previewLine(pull: number | undefined, page: string | undefined): string {
  if (pull === undefined || page === undefined) return "";
  const url = URL.parse(page);
  if (url === null) return "";
  const path = url.pathname.replace(
    /[\\\s\x00-\x1f\x7f<>()\[\]`"'*_~|!#&]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
  if (parseFrom(path) !== path) return "";
  return `from preview of #${pull}, page ${path}`;
}
