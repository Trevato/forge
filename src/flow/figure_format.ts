/**
 * How the home writes a number, once: a count with its thousands (1,234), a
 * span in its two largest units (45m, 3h 5m, 3d 4h), money ($12.40), a share
 * (36%), a page time (1.2s) and an age in words for a sentence (11 days). The
 * strip, the figures and the needs line all use these, so the same quantity
 * is never written two ways.
 */

import { span } from "./pipeline.ts";

/** A count: 1,234. */
export const count = (n: number): string => Math.round(n).toLocaleString("en-US");

/** Dollars: $12.40 under a thousand, $1,234 from there. */
export const money = (n: number): string => (Math.abs(n) >= 1000 ? `$${count(n)}` : `$${n.toFixed(2)}`);

/** A share of one: 36%. */
export const share = (fraction: number): string => `${Math.round(fraction * 100)}%`;

/** A span of time: 45m, 3h 5m, 3d 4h (`pipeline.ts` span), 250ms under a second. */
export const duration = (ms: number): string => (ms < 1000 ? `${Math.round(ms)}ms` : span(ms));

/** A page time: 250ms, 1.2s. */
export const pageTime = (ms: number): string => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);

/** An age as a sentence says it, in the largest sensible unit: under a minute, 5 minutes, 3 hours, 11 days, 2 months. */
export function ageWords(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "under a minute";
  const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return plural(hours, "hour");
  const days = Math.floor(hours / 24);
  return days < 60 ? plural(days, "day") : plural(Math.floor(days / 30), "month");
}
