/**
 * Tokens as a unit — the one formatter for a token count, and the one
 * estimate for text nobody has run through a model yet.
 *
 * A count is shown the way a byte size is (`web/ui.ts` `fileSize`): short,
 * tabular, never on its own (docs/DESIGN.md, "Token counts"). Two bases:
 *
 * - `counted` — the provider reported it (the usage ledger, `core/usage.ts`:
 *   Claude's own tokenizer, whole tokens). Shown bare: `48k tok`.
 * - `estimated` — bytes divided by a calibrated bytes-per-token ratio for
 *   the file's kind. Shown with a tilde: `~1.2k tok`.
 *
 * The ratios are an assumption, stated here and in every tooltip: Anthropic
 * documents roughly 3.5 English characters per Claude token, and OpenAI's
 * cl100k guidance is ~4 for prose. Code splits finer than prose (operators,
 * indentation, identifiers broken at case changes); structured data finer
 * still (quotes, braces, short keys). The ratios below are those rules of
 * thumb, not a measurement: good enough to feel a size, never to bill one.
 *
 * Pure: plain numbers and strings in and out, no I/O.
 */

export type TokenBasis = "counted" | "estimated";

/** What a file is, for the purpose of how finely it tokenizes. */
export type TextKind = "prose" | "code" | "data";

/** Bytes per token, by kind. Prose 4.0, code 3.5, data 3.0 (see above). */
export const BYTES_PER_TOKEN: Readonly<Record<TextKind, number>> = {
  prose: 4.0,
  code: 3.5,
  data: 3.0,
};

const PROSE = new Set(["md", "markdown", "txt", "rst", "adoc", "org", "tex"]);
const DATA = new Set([
  "json",
  "jsonl",
  "ndjson",
  "yaml",
  "yml",
  "toml",
  "csv",
  "tsv",
  "xml",
  "svg",
  "html",
  "htm",
  "lock",
  "ini",
  "cfg",
  "sql",
]);
// Files a model would not read as text at all: no estimate is better than
// a confident wrong one.
const BINARY = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "bmp",
  "avif",
  "pdf",
  "zip",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "zst",
  "7z",
  "tar",
  "jar",
  "wasm",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "mp3",
  "mp4",
  "mov",
  "webm",
  "ogg",
  "wav",
  "flac",
  "db",
  "sqlite",
  "so",
  "dylib",
  "dll",
  "exe",
  "bin",
  "o",
  "a",
  "class",
  "pyc",
]);

function extension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1);
}

/**
 * How a path tokenizes, or `undefined` for a file that is not text. A name
 * with no extension (`Makefile`, `LICENSE`) counts as code: the finer ratio
 * errs toward more tokens, the safer side of an estimate about context.
 */
export function textKind(path: string): TextKind | undefined {
  const ext = extension(path);
  if (BINARY.has(ext)) return undefined;
  if (PROSE.has(ext)) return "prose";
  if (DATA.has(ext)) return "data";
  return "code";
}

/**
 * The estimated token count of `bytes` of the file at `path`: bytes ÷ the
 * kind's ratio, rounded up (one byte is one token, never zero). `undefined`
 * for a binary file or a size that is not a byte count.
 */
export function estimateTokens(bytes: number, path: string): number | undefined {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return undefined;
  const kind = textKind(path);
  if (kind === undefined) return undefined;
  return Math.ceil(bytes / BYTES_PER_TOKEN[kind]);
}

/**
 * A token count the way storage is written: `850 tok`, `1.2k tok`,
 * `48k tok`, `1.1M tok`. One decimal below ten of a unit, whole above;
 * rounding that reaches the next unit moves to it (999,999 is `1.0M`, not
 * `1000k`). An estimate carries a leading `~`.
 */
export function formatTokens(n: number, basis: TokenBasis = "counted"): string {
  const mark = basis === "estimated" ? "~" : "";
  const count = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  return `${mark}${scaled(count)} tok`;
}

function scaled(n: number): string {
  if (n < 1000) return String(n);
  for (const [unit, size] of [
    ["k", 1e3],
    ["M", 1e6],
    ["B", 1e9],
  ] as const) {
    const v = n / size;
    const text = v < 9.95 ? v.toFixed(1) : String(Math.round(v));
    if (Number(text) < 1000 || unit === "B") return `${text}${unit}`;
  }
  return String(n);
}

/**
 * The tooltip every count carries: which tokenizer, the exact number, and
 * — for an estimate — the ratio it came from and that it is one.
 */
export function tokenNote(
  n: number,
  basis: TokenBasis,
  kind?: TextKind,
): string {
  const exact = Math.max(0, Math.round(Number.isFinite(n) ? n : 0));
  const count = `${exact.toLocaleString("en-US")} token${exact === 1 ? "" : "s"}`;
  if (basis === "counted") return `${count}, as counted by Claude's tokenizer`;
  const ratio =
    kind === undefined
      ? "3–4 bytes per token"
      : `${BYTES_PER_TOKEN[kind].toFixed(1)} bytes per token for ${kind}`;
  return `About ${count} — an estimate at ${ratio}; Claude's tokenizer will differ`;
}
