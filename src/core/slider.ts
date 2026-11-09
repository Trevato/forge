/**
 * The profit slider's policy: one forge-wide `position` (an integer 0–100)
 * and the pure function from it to the windows and threshold it means
 * (docs/PROFIT.md). 0 is cheapest — sleep early, cloud only when owned
 * metal is full; 100 is most responsive — stay warm, spill to cloud early.
 * 50 is today's behaviour exactly, so landing this changes nothing.
 *
 * Plain data in, plain data out: nothing here reads the database or acts.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const POSITION_MIN = 0;
export const POSITION_MAX = 100;
export const POSITION_DEFAULT = 50;
export const MARGIN_MAX = 500;
export const MARGIN_DEFAULT = 0;

/**
 * "Never" stands in for infinity in the interpolation: above 50 a window
 * that is "never" at 100 climbs toward this cap, and only 100 itself is
 * `null` (docs/PROFIT.md, "The control").
 */
export const NEVER_CAP_MS = 7 * DAY;

export interface Policy {
  /** Idle milliseconds before an environment sleeps; `null` is never. */
  readonly sleepAfterMs: {
    readonly production: number | null;
    readonly preview: number | null;
  };
  /** Idle milliseconds before a quiet pull's preview stops; `null` is never. */
  readonly idlePullMs: number | null;
  /** Share of owned capacity in use (0–1) above which cloud takes work. */
  readonly spillAtOwnedUse: number;
}

interface Anchor {
  readonly production: number | null;
  readonly preview: number | null;
  readonly idlePull: number | null;
  /** Whole percent, so the arithmetic stays exact until the last step. */
  readonly spillPct: number;
}

/** The three rows of docs/PROFIT.md; 50 is `SLEEP_AFTER_MS` and `IDLE_PULL_DAYS`. */
const ANCHORS: readonly [Anchor, Anchor, Anchor] = [
  { production: 10 * MIN, preview: 5 * MIN, idlePull: 1 * DAY, spillPct: 100 },
  { production: 24 * HOUR, preview: 30 * MIN, idlePull: 3 * DAY, spillPct: 85 },
  { production: null, preview: 24 * HOUR, idlePull: null, spillPct: 60 },
];

/** a + (b − a)·t, with "never" read as the cap; whole milliseconds. */
function lerpMs(a: number | null, b: number | null, t: number): number | null {
  if (t === 1 && b === null) return null;
  if (t === 0 && a === null) return null;
  const from = a ?? NEVER_CAP_MS;
  const to = b ?? NEVER_CAP_MS;
  return Math.round(from + (to - from) * t);
}

/**
 * The policy a position means: linear between the anchor at or below it and
 * the one above. A position outside 0–100 or not whole is a programmer's
 * mistake — the boundary (`parsePosition`) refuses it first — so it is
 * clamped and rounded rather than trusted.
 */
export function policyAt(position: number): Policy {
  const p = Number.isFinite(position)
    ? Math.min(POSITION_MAX, Math.max(POSITION_MIN, Math.round(position)))
    : POSITION_DEFAULT;
  const upper = p > 50;
  const lo = upper ? ANCHORS[1] : ANCHORS[0];
  const hi = upper ? ANCHORS[2] : ANCHORS[1];
  const t = (upper ? p - 50 : p) / 50;
  // Percent to one decimal (the interpolation steps by 0.3 % or 0.5 %), then
  // a share: 72.5 % is 0.725.
  const pct = lo.spillPct + (hi.spillPct - lo.spillPct) * t;
  return {
    sleepAfterMs: {
      production: lerpMs(lo.production, hi.production, t),
      preview: lerpMs(lo.preview, hi.preview, t),
    },
    idlePullMs: lerpMs(lo.idlePull, hi.idlePull, t),
    spillAtOwnedUse: Math.round(pct * 10) / 1000,
  };
}

/**
 * A whole number in [min, max] from a form field or a JSON value; undefined
 * for anything else — fractions, signs, exponents, blanks, booleans, null.
 */
function wholeIn(input: unknown, min: number, max: number): number | undefined {
  let n: number;
  if (typeof input === "number") n = input;
  else if (typeof input === "string" && /^\d{1,4}$/.test(input.trim()))
    n = Number(input.trim());
  else return undefined;
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

export const parsePosition = (input: unknown): number | undefined =>
  wholeIn(input, POSITION_MIN, POSITION_MAX);

export const parseMarginPct = (input: unknown): number | undefined =>
  wholeIn(input, 0, MARGIN_MAX);

/** "24 h", "12 h 5 min", "17 min 30 s", "4 days": the two largest units. */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  const parts: [number, string][] =
    s >= 48 * 3600
      ? [
          [Math.floor(s / 86_400), "days"],
          [Math.floor((s % 86_400) / 3600), "h"],
        ]
      : s >= 3600
        ? [
            [Math.floor(s / 3600), "h"],
            [Math.floor((s % 3600) / 60), "min"],
          ]
        : s >= 60
          ? [
              [Math.floor(s / 60), "min"],
              [s % 60, "s"],
            ]
          : [[s, "s"]];
  return parts
    .filter(([n], i) => i === 0 || n > 0)
    .map(([n, unit]) => `${n} ${unit}`)
    .join(" ");
}

function percent(share: number): string {
  return `${Math.round(share * 1000) / 10}%`;
}

/**
 * The policy in words, one clause per lever:
 * "production sleeps after 24 h idle · previews after 30 min · cloud takes
 * work above 85% of owned capacity · a quiet pull's preview stops after 3 days".
 */
export function policyWords(policy: Policy): string {
  const { production, preview } = policy.sleepAfterMs;
  return [
    production === null
      ? "production never sleeps"
      : `production sleeps after ${duration(production)} idle`,
    preview === null
      ? "previews never sleep"
      : `previews after ${duration(preview)}`,
    policy.spillAtOwnedUse >= 1
      ? "cloud takes work only when owned capacity is full"
      : `cloud takes work above ${percent(policy.spillAtOwnedUse)} of owned capacity`,
    policy.idlePullMs === null
      ? "a quiet pull's preview never stops"
      : `a quiet pull's preview stops after ${duration(policy.idlePullMs)}`,
  ].join(" · ");
}

// ---- prices (#507): what the operator pays, beside the position ----

/**
 * What the operator pays, as whole US cents so that two decimals stay exact
 * (docs/PROFIT.md, "Units and formulas"). Units are in the names:
 * - `ownedMonthCents`: the owned box, US cents per calendar month, a fixed
 *   cost whatever runs on it;
 * - `ownedSlots`: how many apps the box holds awake at once (app-slots);
 * - `cloudHourCents`: US cents per awake-hour on a cloud;
 * - `storageGbMonthCents`: US cents per GB-month (decimal GB) kept.
 */
export interface Prices {
  readonly ownedMonthCents: number;
  readonly ownedSlots: number;
  readonly cloudHourCents: number;
  readonly storageGbMonthCents: number;
}

export type PriceKey = keyof Prices;
export const PRICE_KEYS: readonly PriceKey[] = [
  "ownedMonthCents",
  "ownedSlots",
  "cloudHourCents",
  "storageGbMonthCents",
];

/** Nothing priced until the operator says: an unpriced forge costs $0. */
export const PRICES_DEFAULT: Prices = {
  ownedMonthCents: 0,
  ownedSlots: 0,
  cloudHourCents: 0,
  storageGbMonthCents: 0,
};

/** $1,000,000.00: far above any one box, low enough to stay a safe integer. */
export const PRICE_MAX_CENTS = 100_000_000;
export const SLOTS_MAX = 10_000;

/**
 * A price in dollars with at most two decimals, non-negative, up to
 * `PRICE_MAX_CENTS`, as whole cents: "300" → 30000, "0.05" → 5, 0.5 → 50.
 * Undefined for signs, exponents, a third decimal, blanks, booleans, null.
 */
export function parseUsdCents(input: unknown): number | undefined {
  let cents: number;
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) return undefined;
    cents = Math.round(input * 100);
    // 0.05 * 100 is 5.000000000000001: within a millionth of a cent is two decimals.
    if (Math.abs(input * 100 - cents) > 1e-6) return undefined;
  } else if (typeof input === "string") {
    const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(input.trim());
    if (m === null) return undefined;
    cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  } else return undefined;
  return cents <= PRICE_MAX_CENTS ? cents : undefined;
}

export const parseSlots = (input: unknown): number | undefined =>
  wholeIn(input, 0, SLOTS_MAX);

/** Whole cents as dollars with two decimals and no sign: 30000 → "300.00". */
export function usdOfCents(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
