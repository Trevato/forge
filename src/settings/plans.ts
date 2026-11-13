/**
 * Plans: free, small, medium and large as a setting, never a constant. Each
 * has a key, a name, one line of words, a forge size (`spawn/sizes.ts`), a
 * price in USD a month (0 is free), a crew credit in USD a month (the cap
 * lent to the child's crew, `spawn/credit.ts`) and how many forges one person
 * may hold on it. Kept as one JSON value in `forge_setting` under `plans`, so
 * a change governs the next read and needs no restart; each change is kept in
 * `forge_setting_change`. A stored value that does not parse reads as the
 * defaults. Pure data; authorization is in `actions/plans.ts`.
 */

import type { Database } from "bun:sqlite";
import { err, ok, type Result } from "../kernel/result.ts";
import { isSize, SIZES, type Size } from "../spawn/sizes.ts";
import { writeSetting } from "./limits.ts";

export interface Plan {
  readonly key: string;
  readonly name: string;
  readonly says: string;
  readonly size: Size;
  /** US dollars a month; 0 is free. */
  readonly priceUsd: number;
  /** US dollars of the forge's model credential a month, lent to the child's crew; 0 lends none. */
  readonly creditUsd: number;
  /** How many forges one person may hold on this plan. */
  readonly forges: number;
}

/** The plan every forge has: its price is always 0 and its limits are the visitor and per-person limits. */
export const FREE = "free";
/** Why a paid plan is a forge admin's for now: it lends crew credit from the forge's own model credential, and no payment is taken yet. */
export const PAID_PLAN_ADMIN_ONLY = (name: string): string =>
  `the ${name} plan lends crew credit and no payment is taken yet, so only a forge admin may take it; use the free plan`;
export const PLANS_KEY = "plans";
export const MAX_PLANS = 8;
export const MAX_USD = 100_000;
export const MAX_FORGES = 1000;

export const DEFAULT_PLANS: readonly Plan[] = [
  { key: "free", name: "Free", says: "A small forge that sleeps when idle, with the crew on included credit.", size: "small", priceUsd: 0, creditUsd: 0, forges: 3 },
  { key: "small", name: "Small", says: "A small forge, awake, with a crew credit each month.", size: "small", priceUsd: 19, creditUsd: 5, forges: 3 },
  { key: "medium", name: "Medium", says: "A medium forge for a busy app, with more crew credit.", size: "medium", priceUsd: 49, creditUsd: 15, forges: 3 },
  { key: "large", name: "Large", says: "A large forge for a working crew, with the most credit.", size: "large", priceUsd: 149, creditUsd: 50, forges: 3 },
];

const KEY = /^[a-z][a-z0-9-]{0,19}$/;
const cents = (n: number): number => Math.round(n * 100) / 100;

function usd(v: unknown): number | undefined {
  const n = typeof v === "string" && /^\d{1,6}(\.\d{1,2})?$/.test(v.trim()) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > MAX_USD) return undefined;
  return Math.abs(n * 100 - Math.round(n * 100)) > 1e-6 ? undefined : cents(n);
}

function count(v: unknown): number | undefined {
  const n = typeof v === "string" && /^\d{1,4}$/.test(v.trim()) ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MAX_FORGES ? n : undefined;
}

function line(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s !== "" && s.length <= max && !/[\u0000-\u001f\u007f]/.test(s) ? s : undefined;
}

/** One plan from untrusted input, or the sentence that says what is wrong with it. */
export function parsePlan(raw: unknown): Result<Plan, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return err("a plan is an object");
  const p = raw as Record<string, unknown>;
  const key = typeof p["key"] === "string" && KEY.test(p["key"]) ? p["key"] : undefined;
  if (key === undefined) return err('a plan key is 1-20 characters of a-z, 0-9 and "-", starting with a letter');
  const name = line(p["name"], 40);
  if (name === undefined) return err(`${key}: name is one line of at most 40 characters`);
  const says = line(p["says"], 160);
  if (says === undefined) return err(`${key}: says is one line of at most 160 characters`);
  const size = p["size"];
  if (!isSize(size)) return err(`${key}: size must be ${Object.keys(SIZES).join(", ")}`);
  const priceUsd = usd(p["priceUsd"]);
  if (priceUsd === undefined) return err(`${key}: priceUsd is dollars from 0 to ${MAX_USD}, at most two decimals`);
  const creditUsd = usd(p["creditUsd"]);
  if (creditUsd === undefined) return err(`${key}: creditUsd is dollars from 0 to ${MAX_USD}, at most two decimals`);
  const forges = count(p["forges"]);
  if (forges === undefined) return err(`${key}: forges is a whole number from 1 to ${MAX_FORGES}`);
  if (key === FREE && priceUsd !== 0) return err("the free plan costs $0");
  return ok({ key, name, says, size, priceUsd, creditUsd, forges });
}

/** A whole list of plans from untrusted input: one to eight, unique keys, `free` among them. */
export function parsePlans(raw: unknown): Result<Plan[], string> {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_PLANS) return err(`plans is a list of 1 to ${MAX_PLANS} plans`);
  const plans: Plan[] = [];
  for (const r of raw) {
    const p = parsePlan(r);
    if (!p.ok) return p;
    if (plans.some((q) => q.key === p.value.key)) return err(`${p.value.key} is listed twice`);
    plans.push(p.value);
  }
  if (!plans.some((p) => p.key === FREE)) return err("the free plan cannot be removed");
  return ok(plans);
}

/** A stored plans value as plans; anything that does not parse reads as the defaults. */
export function decodePlans(raw: string | undefined): Plan[] {
  if (raw !== undefined) {
    try {
      const parsed = parsePlans(JSON.parse(raw));
      if (parsed.ok) return parsed.value;
    } catch {
      // a hand-edited value reads as the defaults
    }
  }
  return DEFAULT_PLANS.map((p) => ({ ...p }));
}

/** The plans in force now, read on every use. */
export function getPlans(db: Database): Plan[] {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM forge_setting WHERE key = ?1").get(PLANS_KEY);
  return decodePlans(row?.value);
}

export function getPlan(db: Database, key: string): Plan | undefined {
  return getPlans(db).find((p) => p.key === key);
}

const words = (plans: readonly Plan[]): string =>
  plans.map((p) => `${p.key} ${p.size} $${p.priceUsd}/$${p.creditUsd}×${p.forges}`).join(", ");

/** Replace the plans (validated by the caller) and keep the change. */
export function setPlans(db: Database, plans: readonly Plan[], actorId: string): void {
  const before = getPlans(db);
  const next = JSON.stringify(plans);
  if (next === JSON.stringify(before)) return;
  writeSetting(db, PLANS_KEY, next, words(before), words(plans), actorId);
}

/** The plans as the public sees them: only the named fields leave. */
export function publicPlans(plans: readonly Plan[]): Plan[] {
  return plans.map(({ key, name, says, size, priceUsd, creditUsd, forges }) => ({ key, name, says, size, priceUsd, creditUsd, forges }));
}
