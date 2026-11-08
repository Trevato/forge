/**
 * One account's window, in a sentence: `5-hour: $3.10 used of $10.00 (31%) ·
 * 1.2k tok · resets 12:04 UTC`. A leading `~` marks a figure the ledger
 * inferred rather than the provider said. Settings › Subscriptions and the
 * terminal's Subscriptions screen both say it with this one function.
 */

import { whenText } from "../crew/limits.ts";
import type { Figure, WindowStanding } from "../core/standing.ts";
import { formatTokens } from "../kernel/tokens-format.ts";

const usd = (n: number): string => `$${n.toFixed(2)}`;
const mark = (f: Figure<unknown>): string => (f.source === "read" ? "" : "~");

/** The sentence in three pieces, so a page can dress the token count; `windowWords` joins them. */
export function windowParts(w: WindowStanding): { head: string; tokens: number; tail: string } {
  const name = w.window === "5h" ? "5-hour" : "weekly";
  const used = `${mark(w.used)}${usd(w.used.value)} used`;
  const of =
    w.cap === null
      ? ""
      : ` of ${mark(w.cap)}${usd(w.cap.value)}${
          w.cap.value > 0
            ? ` (${Math.min(100, Math.round((w.used.value / w.cap.value) * 100))}%)`
            : ""
        }`;
  const full =
    w.remaining?.source === "read" && w.remaining.value === 0 ? " · full" : "";
  const resets =
    w.resetsAt === null
      ? " · opens on next use"
      : ` · resets ${mark(w.resetsAt)}${whenText(new Date(w.resetsAt.value))}`;
  return { head: `${name}: ${used}${of}`, tokens: w.tokensIn + w.tokensOut, tail: `${full}${resets}` };
}

export function windowWords(w: WindowStanding): string {
  const { head, tokens, tail } = windowParts(w);
  return `${head}${tokens > 0 ? ` · ${formatTokens(tokens, "counted")}` : ""}${tail}`;
}
