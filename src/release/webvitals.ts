/**
 * The website specification's Core Web Vitals, graded from what a page
 * recorded (#2982, part of #2915 check 9). `webvitals()` takes the
 * `largest-contentful-paint`, `layout-shift` and `longtask` performance
 * entries as plain data and returns LCP, CLS and TBT, each graded against the
 * specification.website thresholds and citing its section. Pure: no browser,
 * no clock, no I/O. Entries that are not finite, non-negative numbers are
 * dropped at the boundary, never trusted.
 *
 * Thresholds (good / poor; between is needs-improvement), as web.dev states
 * them and specification.website cites:
 * - LCP: good <= 2500 ms, poor > 4000 ms.
 * - CLS: good <= 0.1, poor > 0.25 (unitless).
 * - INP: good <= 200 ms, poor > 500 ms. A lab run has no interactions, so
 *   Total Blocking Time stands in for it, graded with Lighthouse's TBT
 *   scale: good <= 200 ms, poor > 600 ms.
 */

export type Grade = "good" | "needs-improvement" | "poor";

export interface Vital {
  /** The measured value, or null when the page recorded no entry for it. */
  value: number | null;
  grade: Grade | null;
  /** Upper bound of "good", inclusive. */
  good: number;
  /** Upper bound of "needs-improvement", inclusive; above it is "poor". */
  poor: number;
  unit: "ms" | "";
  /** The specification.website section this vital cites. */
  section: string;
}

export interface WebVitals {
  lcpMs: Vital;
  cls: Vital;
  tbtMs: Vital;
}

/** The fields of a recorded entry this module reads; anything else is ignored. */
export interface Entries {
  lcp?: readonly unknown[];
  layoutShift?: readonly unknown[];
  longtask?: readonly unknown[];
}

const SPEC = "https://specification.website/";
const s = (name: string) => `${SPEC}#${name}`;

export const LCP = { good: 2500, poor: 4000, unit: "ms", section: s("largest-contentful-paint") } as const;
export const CLS = { good: 0.1, poor: 0.25, unit: "", section: s("cumulative-layout-shift") } as const;
/** TBT is the lab proxy for INP (good <= 200 ms); poor follows Lighthouse's TBT scale. */
export const TBT = { good: 200, poor: 600, unit: "ms", section: s("interaction-to-next-paint") } as const;

/** A long task blocks the main thread for whatever it runs past 50 ms. */
export const BLOCKING_MS = 50;
/** CLS session windows: a gap of 1 s or more starts a new window, and no window spans more than 5 s. */
export const SESSION_GAP_MS = 1000;
export const SESSION_CAP_MS = 5000;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const field = (e: unknown, k: string): unknown => (e && typeof e === "object" ? (e as Record<string, unknown>)[k] : undefined);
const list = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);

export function grade(value: number, t: { good: number; poor: number }): Grade {
  return value <= t.good ? "good" : value <= t.poor ? "needs-improvement" : "poor";
}

function vital(value: number | null, t: { good: number; poor: number; unit: "ms" | ""; section: string }): Vital {
  return { value, grade: value === null ? null : grade(value, t), good: t.good, poor: t.poor, unit: t.unit, section: t.section };
}

/**
 * LCP is the render time of the largest candidate the page reported. The
 * browser only reports a candidate larger than the last, so the largest
 * `size` is the final one; without sizes the latest `startTime` stands.
 * `startTime` is renderTime, or loadTime for cross-origin images without
 * Timing-Allow-Origin.
 */
export function lcpMs(entries: readonly unknown[]): number | null {
  let best: { t: number; size: number } | null = null;
  for (const e of entries) {
    const t = num(field(e, "startTime"));
    if (t === null) continue;
    const size = num(field(e, "size")) ?? 0;
    if (!best || size > best.size || (size === best.size && t > best.t)) best = { t, size };
  }
  return best && Math.round(best.t);
}

/**
 * CLS is the largest session window's sum of shift values. Shifts within
 * 500 ms of input (`hadRecentInput`) are expected and do not count. A window
 * closes when the next shift comes 1 s or more after the previous one, or
 * 5 s or more after the window's first.
 */
export function cls(entries: readonly unknown[]): number {
  const shifts: { t: number; v: number }[] = [];
  for (const e of entries) {
    if (field(e, "hadRecentInput") === true) continue;
    const t = num(field(e, "startTime"));
    const v = num(field(e, "value"));
    if (t !== null && v !== null) shifts.push({ t, v });
  }
  shifts.sort((a, b) => a.t - b.t);
  let max = 0;
  let sum = 0;
  let first = -Infinity;
  let prev = -Infinity;
  for (const { t, v } of shifts) {
    if (t - prev >= SESSION_GAP_MS || t - first >= SESSION_CAP_MS) {
      sum = 0;
      first = t;
    }
    sum += v;
    prev = t;
    if (sum > max) max = sum;
  }
  // Four places hide float noise (0.07 + 0.03) without moving a grade.
  return Math.round(max * 1e4) / 1e4;
}

/** TBT sums, over every long task, the part of its duration past 50 ms. */
export function tbtMs(entries: readonly unknown[]): number {
  let total = 0;
  for (const e of entries) {
    const d = num(field(e, "duration"));
    if (d !== null && d > BLOCKING_MS) total += d - BLOCKING_MS;
  }
  return Math.round(total);
}

/**
 * Grades what a page recorded. A page that recorded no LCP candidate gets a
 * null LCP; no shifts is a CLS of 0 and no long tasks a TBT of 0, both
 * measured, not missing.
 */
export function webvitals(input: Entries): WebVitals {
  return {
    lcpMs: vital(lcpMs(list(input?.lcp)), LCP),
    cls: vital(cls(list(input?.layoutShift)), CLS),
    tbtMs: vital(tbtMs(list(input?.longtask)), TBT),
  };
}
