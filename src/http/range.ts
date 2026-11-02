/**
 * One HTTP byte range (RFC 9110 §14), as plain data. A video seeks and a PDF
 * streams by asking for a window of a file; this reads which window.
 *
 * Only a single range is honoured. A list of ranges, a unit other than
 * bytes, or a header that does not parse is ignored, which the RFC allows:
 * the whole file goes out with 200, and nothing is refused that a browser
 * would ask for.
 */

/** Inclusive at both ends, as `Content-Range` writes it. */
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/**
 * The window `header` asks for in a file of `size` bytes: a range, `null`
 * for the whole file, or `"unsatisfiable"` (416) when it starts past the end.
 */
export function parseRange(
  header: string | null,
  size: number,
): ByteRange | "unsatisfiable" | null {
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") return null;
  if (first === "") {
    // A suffix: the last N bytes.
    const length = Number(last);
    if (!Number.isSafeInteger(length)) return null;
    if (length === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(first);
  const end = last === "" ? Number.MAX_SAFE_INTEGER : Number(last);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  if (end < start) return null;
  if (start >= size) return "unsatisfiable";
  return { start, end: Math.min(end, size - 1) };
}
