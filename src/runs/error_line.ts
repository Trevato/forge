/**
 * The line of a run's log that says what broke: the first one carrying an
 * error or fail marker, and its 1-based place in the lines `readRunLog`
 * returns — the same count the run page numbers its rows by (`#L<n>`).
 * Read once, when the run finishes, and kept with the event; the feed never
 * opens a log.
 */

/** bun's `(fail)`, `error:`, `Error`, `failed`, `failure` — as words, any case. */
const MARKER = /\(fail\)|\b(?:error|fail(?:ed|ure|s)?)\b/i;

export const ERROR_LINE_MAX = 120;

export interface ErrorLine {
  /** The line, trimmed and cut to `ERROR_LINE_MAX`. */
  text: string;
  /** Its 1-based number in the log. */
  at: number;
}

export function firstErrorLine(lines: readonly string[]): ErrorLine | undefined {
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!.trim();
    if (text !== "" && MARKER.test(text))
      return { text: text.length > ERROR_LINE_MAX ? `${text.slice(0, ERROR_LINE_MAX - 1)}…` : text, at: i + 1 };
  }
  return undefined;
}
