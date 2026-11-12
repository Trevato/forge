/** A terminal log (.log, .ansi) with its colours, laid out as the code view is. */

import { html, raw } from "../html.ts";
import { rowsMarkup } from "../code_rows.ts";
import { btn, empty } from "../ui.ts";
import { ansiLines } from "./ansi.ts";
import type { Rendered, RenderInput } from "./renderers.ts";

/** The same windows the plain-text view draws: first lines, then up to the ceiling. */
const FIRST_LINES = 1_500;
const MAX_LINES = 10_000;

/** Whether a body holds an escape at all; one without is shown as plain text. */
export const hasEscape = (body: Uint8Array): boolean => body.includes(0x1b);

export function log(input: RenderInput): Rendered {
  const { lines, total } = ansiLines(new TextDecoder().decode(input.body), input.all ? MAX_LINES : FIRST_LINES);
  const cut = total - lines.length;
  const href = input.pathHref ?? "";
  return {
    lines: total,
    content: html`<div class="card code ansi">
        <table>
          ${raw(rowsMarkup(lines.map(raw)))}
        </table>
      </div>
      ${cut > 0
        ? empty({
            icon: "file",
            title: `${cut.toLocaleString("en-US")} more lines`,
            note: input.all ? "The rest is in the raw file." : "The page draws the first lines so it opens at once.",
            action: input.all ? html`` : btn("Show all lines", { href: `${href}?all=1`, id: "code-cut", icon: "file" }),
          })
        : html``}`,
  };
}

/** A timestamp a log line may open with: `2026-01-02T03:04:05Z`, `[03:04:05.123]`. */
const STAMP = /^\s*\[?(?:\d{4}-\d\d-\d\d[T ])?\d\d:\d\d:\d\d(?:[.,]\d+)?(?:Z|[+-]\d\d:?\d\d)?\]?[\s:|-]*/;
const BARE = /^(ERROR|ERR|FATAL|CRITICAL|CRIT|PANIC|WARN|WARNING|DEBUG|TRACE)(?![A-Za-z0-9_])/;
const BRACKET = /^[[(<](error|err|fatal|critical|crit|panic|warn|warning|debug|trace)[\])>]/i;
const LOGFMT = /^(?:\S+=\S+\s+){0,4}level=(error|err|fatal|warn|warning|debug|trace)\b/i;

/**
 * The level a log line states in its first token (after an optional timestamp):
 * `ERROR x`, `[warn] x`, `level=error x`. Prose that merely mentions a word
 * ("no errors found", "0 failed") has none.
 */
export function logLevel(line: string): "error" | "warn" | "debug" | undefined {
  const rest = line.replace(STAMP, "");
  const word = BARE.exec(rest)?.[1] ?? BRACKET.exec(rest)?.[1] ?? LOGFMT.exec(line)?.[1];
  if (word === undefined) return undefined;
  const w = word.toLowerCase();
  if (w.startsWith("warn")) return "warn";
  if (w === "debug" || w === "trace") return "debug";
  return "error";
}
