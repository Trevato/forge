/**
 * The figures row in words (#2871): shared by home and the terminal, which
 * must not depend on each other. Plain data in, plain strings out.
 */

import type { Kpis } from "./kpis.ts";
import type { Reach } from "./reach.ts";

/** A duration the way a person reads a check: `45s`, `3m 05s`, `1h 02m`. */
export function checkTime(ms: number | null): string {
  if (ms === null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

const BLOCKS = "▁▂▃▄▅▆▇█";

/** The terminal's sparkline: the same 24 hours, oldest on the left, one block each. */
export function sparkText(hours: readonly number[]): string {
  return trendText([...hours].reverse());
}

/** One block per value, oldest on the left; the series is already in that order. */
export function trendText(series: readonly number[]): string {
  const top = Math.max(1, ...series);
  return series
    .map((v) => (v === 0 ? BLOCKS[0]! : BLOCKS[Math.min(BLOCKS.length - 1, Math.ceil((v / top) * (BLOCKS.length - 1)))]!))
    .join("");
}

/** Builders running of their slots: `2 of 4`, or an em dash when no slots are set. */
export function buildersValue(b: Kpis["builders"]): string {
  return b.slots === 0 ? "—" : `${b.running} of ${b.slots}`;
}

/** Cents below ten dollars, so a small spend never reads `$0`; whole dollars above. */
const whole = (n: number): string => (n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`);
const cents = (n: number): string => `$${n.toFixed(2)}`;

/** Today's spend of the daily ceiling: `$12 of $40`, or the spend alone with no ceiling. */
export function spendValue(s: Kpis["spend"]): string {
  return s.ceilingUsd === null ? whole(s.todayUsd) : `${whole(s.todayUsd)} of ${whole(s.ceilingUsd)}`;
}

/** The same figure to the cent, for the title. */
export function spendFull(s: Kpis["spend"]): string {
  return s.ceilingUsd === null ? cents(s.todayUsd) : `${cents(s.todayUsd)} of ${cents(s.ceilingUsd)}`;
}

const DAY_MS = 24 * 3_600_000;

/** Past a day, or with no backup at all, the last off-box backup is overdue. */
export function backupOverdue(at: string | null, now: Date): boolean {
  return at === null || !(now.getTime() - Date.parse(at) <= DAY_MS);
}

/** The backup's age as a person reads it: `3 h ago`, `2 d ago`, or `never`. */
export function backupAge(at: string | null, now: Date): string {
  const t = at === null ? NaN : Date.parse(at);
  if (Number.isNaN(t)) return "never";
  const min = Math.max(0, Math.floor((now.getTime() - t) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  if (min < 2880) return `${Math.floor(min / 60)} h ago`;
  return `${Math.floor(min / 1440)} d ago`;
}

/** The exact time, for the title. */
export function backupFull(at: string | null): string {
  return at === null || Number.isNaN(Date.parse(at)) ? "No off-box backup yet" : at;
}

/** A page speed the way a person reads it: `850 ms`, `1.2 s`, or an em dash for none. */
export function speedWords(ms: number | null): string {
  if (ms === null) return "—";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** Accounts signed in today of all accounts: `3 of 12`. */
export function usersValue(r: Reach): string {
  return `${r.usersToday} of ${r.usersTotal}`;
}

/** Visitors today, in words: `5 today`. */
export function visitorsValue(r: Reach): string {
  return `${r.visitorsToday} today`;
}

/** The week behind it: `31 in 7 days`. */
export function visitorsNote(r: Reach): string {
  return `${r.visitors7d} in 7 days`;
}

/** How quick the pages feel, over 7 days: `reacts in 180 ms`, or why there is no figure. */
export function reactNote(r: Reach): string {
  return r.inpP75 === null ? "no taps measured yet" : `reacts in ${speedWords(r.inpP75)}`;
}

/**
 * The terminal's row: the same figures in the same words, as plain
 * lines. Forge-wide like the web's, so the caller shows them to an admin only.
 */
export function kpiLines(k: Kpis, live: { sha: string; since: string } | null, now: Date = new Date()): string[] {
  return [
    `Shipped per hour ${(k.landed / k.landedHours.length).toFixed(1)}  ${sparkText(k.landedHours)}  ${k.landed} ${k.landed === 1 ? "change" : "changes"} in 24 h`,
    `Live version ${live === null ? "— nothing live yet" : `${live.sha.slice(0, 7)}, live ${live.since}`}`,
    `Median check time ${checkTime(k.medianCheckMs)}`,
    `Builders running ${buildersValue(k.builders)}${k.builders.slots === 0 ? ", no slots set" : ""}`,
    `Crew spend today ${spendValue(k.spend)}${k.spend.ceilingUsd === null ? ", no ceiling" : ""}`,
    `Last off-box backup ${backupAge(k.backupAt, now)}${backupOverdue(k.backupAt, now) ? ", overdue" : ""}`,
    `Visitors ${visitorsValue(k.reach)}, ${visitorsNote(k.reach)}  ${trendText(k.reach.visitorDays)}  30 days`,
    `Accounts ${usersValue(k.reach)} signed in today`,
    `Page speed ${k.reach.loadP75 === null ? "no page views measured yet" : `loads in ${speedWords(k.reach.loadP75)}`}, ${reactNote(k.reach)}`,
  ];
}
