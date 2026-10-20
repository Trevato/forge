/**
 * The figures row in words (#2871): shared by home and the terminal, which
 * must not depend on each other. Plain data in, plain strings out.
 */

import type { Kpis } from "./kpis.ts";

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
  const top = Math.max(1, ...hours);
  return [...hours]
    .reverse()
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

/**
 * The terminal's row: the same five figures in the same words, as plain
 * lines. Forge-wide like the web's, so the caller shows them to an admin only.
 */
export function kpiLines(k: Kpis, live: { sha: string; since: string } | null): string[] {
  return [
    `Shipped per hour ${(k.landed / k.landedHours.length).toFixed(1)}  ${sparkText(k.landedHours)}  ${k.landed} ${k.landed === 1 ? "change" : "changes"} in 24 h`,
    `Live version ${live === null ? "— nothing live yet" : `${live.sha.slice(0, 7)}, live ${live.since}`}`,
    `Median check time ${checkTime(k.medianCheckMs)}`,
    `Builders running ${buildersValue(k.builders)}${k.builders.slots === 0 ? ", no slots set" : ""}`,
    `Crew spend today ${spendValue(k.spend)}${k.spend.ceilingUsd === null ? ", no ceiling" : ""}`,
  ];
}
