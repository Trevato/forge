/**
 * The figures row in words (#2871): shared by home and the terminal, which
 * must not depend on each other. Plain data in, plain strings out.
 */

import type { Kpis } from "./kpis.ts";
import type { Reach } from "./reach.ts";
import { ATTENTION_REQUESTS, TRAFFIC_CLASSES, type TrafficClass, type TrafficTotals } from "../perf/traffic.ts";

/**
 * What each home number counts, one sentence each: the tile's title and the
 * probe's `counts` (`web/studio/kpi_probe.ts`) read the same words.
 */
export const KPI_COUNTS = {
  shipped: "Changes shipped in the last 24 hours, across every project, averaged per hour; one that put nothing new in doesn't count.",
  live: "The version this forge process is running, and when that process booted.",
  checks: "The median duration of checks that finished ok or failed in the last 24 hours, across every project; a cancelled check doesn't count.",
  builders: "Agent runs running now, of the slots set on projects whose autonomy is on.",
  spend: "What crew runs cost since UTC midnight at token list price, which is not what a subscription bills, of the forge's daily ceiling.",
  backup: "How long ago a snapshot was last known to be off this machine.",
  bugs: "Open bugs, and those past their clock: 4 h high, 48 h otherwise.",
  traffic: "Who used the forge's answering time this minute and the 14 before, as a share of summed time to answer: people and tokens, named crawlers, anonymous readers on deep pages, other anonymous, the forge asking itself. Refused means answered 429.",
  visitors: "Browsers whose page sent a report back today (UTC); scrapers don't run the page, so they never count. The 7-day figure adds each day's count, so a browser seen on three days counts three times.",
  accounts: "Accounts with a browser session seen since UTC midnight, of every account including organizations and machine accounts; a token alone doesn't count.",
  speed: "The slowest quarter of page views that reported back over 7 days: page load at the 75th percentile, and the delay after a tap. Scrapers don't report and an outage reports nothing, so this shows neither.",
} as const;

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
export function buildersValue(b: Pick<Kpis["builders"], "running" | "slots">): string {
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

/** The `HH:MMZ` of an ISO time. */
const hhmmZ = (iso: string): string => `${iso.slice(11, 16)}Z`;

/** The forge ceiling's state in words, shared by the tile and the terminal row. */
export function spendCeilingWords(s: Kpis["spend"]): { note: string; title: string; attn: boolean } {
  if (s.ceilingUsd === null) return { note: "no forge ceiling", title: "No forge ceiling is set", attn: false };
  if (s.todayUsd >= s.ceilingUsd) {
    const note = s.hitAt ? `ceiling hit ${hhmmZ(s.hitAt)}, builders idle` : "ceiling hit, builders idle";
    return { note, title: note, attn: true };
  }
  return { note: "of the forge ceiling", title: "Crew spend today (UTC) at token list price, of the forge ceiling", attn: false };
}

/** The terminal's tail on the spend line: only the two states worth a word. */
function spendLineNote(s: Kpis["spend"]): string {
  const w = spendCeilingWords(s);
  return w.attn || s.ceilingUsd === null ? `, ${w.note}` : "";
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

/** Shipped per hour, as the tile shows it. */
export function shippedValue(landed: number, hours: number): string {
  return (landed / hours).toFixed(1);
}

/** The backup tile's figure: an em dash when the bucket has not been read and nothing is known. */
export function backupValue(k: Pick<Kpis, "backup" | "backupAt">, now: Date): string {
  return k.backup?.state === "unknown" && k.backupAt === null ? "—" : backupAge(k.backupAt, now);
}

/** Each traffic class, as a person reads it. */
export const TRAFFIC_WORDS: Readonly<Record<TrafficClass, string>> = {
  people: "people and tokens",
  crawlers: "named crawlers",
  deep: "anonymous deep pages",
  other: "other anonymous",
  internal: "the forge itself",
};

const share = (part: number, whole: number): string => {
  if (whole <= 0) return "0%";
  const pct = (part / whole) * 100;
  return pct > 0 && pct < 1 ? "<1%" : `${Math.round(pct)}%`;
};

/** A share of the window's answering time: `91%`, `<1%`. */
export const trafficShare = (t: Pick<TrafficTotals, "ms">, ms: number): string => share(ms, t.ms);

type TrafficFigures = Pick<TrafficTotals, "requests" | "ms" | "classes">;

/** The class that took the most answering time, null when nothing was answered. */
export function trafficTop(t: TrafficFigures): TrafficClass | null {
  if (t.requests === 0) return null;
  return TRAFFIC_CLASSES.reduce((a, b) => (t.classes[b].ms > t.classes[a].ms ? b : a));
}

/** The tile's figure: the top class's share of answering time. */
export function trafficValue(t: TrafficFigures): string {
  const top = trafficTop(t);
  return top === null ? "—" : share(t.classes[top].ms, t.ms);
}

/** Whether strangers hold most of the time: anonymous deep readers or named crawlers, past a handful of requests. */
export function trafficAttention(t: TrafficFigures): "deep" | "crawlers" | null {
  for (const c of ["deep", "crawlers"] as const)
    if (t.classes[c].requests >= ATTENTION_REQUESTS && t.classes[c].ms > t.ms / 2) return c;
  return null;
}

/** The tile's words. */
export function trafficWords(t: TrafficTotals): { note: string; title: string; attn: boolean } {
  const top = trafficTop(t);
  if (top === null) return { note: "no requests in 15 min", title: KPI_COUNTS.traffic, attn: false };
  const by = TRAFFIC_CLASSES.map((c) => `${TRAFFIC_WORDS[c]} ${share(t.classes[c].ms, t.ms)} (${t.classes[c].requests})`).join(", ");
  const facts = `${by}. ${t.refused} refused, about ${t.addresses} ${t.addresses === 1 ? "address" : "addresses"}.`;
  const wrong = trafficAttention(t);
  if (wrong !== null)
    return {
      note: `of time: ${wrong === "deep" ? "anonymous deep" : "crawlers"}, too much`,
      title: `Something is wrong: ${TRAFFIC_WORDS[wrong]} took most of the answering time, so everyone else waits. ${facts}`,
      attn: true,
    };
  return { note: `of time: ${TRAFFIC_WORDS[top]}`, title: `Share of answering time over the last 15 minutes: ${facts}`, attn: false };
}

/** Home's one line over /review: `3 waiting on you, oldest 50 h`; null at zero, so the line is absent. */
export function waitingWords(count: number, oldestAt: string | null, now: Date): string | null {
  if (count <= 0) return null;
  const t = oldestAt === null ? NaN : Date.parse(oldestAt);
  if (Number.isNaN(t)) return `${count} waiting on you`;
  const h = Math.max(0, Math.floor((now.getTime() - t) / 3_600_000));
  return `${count} waiting on you, oldest ${h < 1 ? "under 1" : h} h`;
}

/** The fold for asks older than 30 days, on Home and on /review. */
export function staleWords(count: number): string {
  return `${count} stale, archive?`;
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
    `Builders running ${buildersValue(k.builders)}${k.builders.slots === 0 ? ", no slots set" : ""}${k.builders.idle === null ? "" : ` · ${k.builders.idle.word}`}`,
    `Crew spend today ${spendValue(k.spend)}${spendLineNote(k.spend)}`,
    k.backup ? k.backup.line : `Last off-box backup ${backupAge(k.backupAt, now)}${backupOverdue(k.backupAt, now) ? ", overdue" : ""}`,
    `Reporting browsers ${visitorsValue(k.reach)}, ${visitorsNote(k.reach)}  ${trendText(k.reach.visitorDays)}  30 days`,
    `Accounts ${usersValue(k.reach)} seen today`,
    `Reported page speed ${k.reach.loadP75 === null ? "no page views measured yet" : `loads in ${speedWords(k.reach.loadP75)}`}, ${reactNote(k.reach)}`,
  ];
}
