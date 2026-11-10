/**
 * The parent's credit to one child: a dollar cap an admin sets, the spend
 * counted against it, and the bearer the child's crew presents to the model
 * door (`spawn/model_door.ts`). One small file per child under
 * `<data>/credit/<name>.json`, beside the ledger and the beats; only the
 * bearer's hash is kept here, the bearer itself lives in the child's
 * `parent.json`. Reads and writes are synchronous, so a check and the spend
 * it follows cannot interleave in this one process.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../app.ts";
import { isChildName } from "../core/proposal_token.ts";

export interface Credit {
  readonly name: string;
  readonly capUsd: number;
  readonly spentUsd: number;
  readonly tokenHash: string;
  /** A plan's monthly credit: the UTC month (`YYYY-MM`) the spend is counted in; it starts again at 0 each month. Absent for a cap that does not reset. */
  readonly period?: string;
}

export const CREDIT_MAX_USD = 100_000;

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const path = (app: App, name: string): string => join(app.config.dataDir, "credit", `${name}.json`);
const cents = (n: number): number => Math.round(n * 100) / 100;

/** The UTC calendar month a credit period is counted in. */
export const periodOf = (at: Date = new Date()): string => at.toISOString().slice(0, 7);

export function readCredit(app: App, name: string, now: Date = new Date()): Credit | undefined {
  if (!isChildName(name)) return undefined;
  try {
    const d = JSON.parse(readFileSync(path(app, name), "utf8")) as Record<string, unknown>;
    const { capUsd, spentUsd, tokenHash, period } = d;
    if (typeof capUsd !== "number" || typeof spentUsd !== "number" || typeof tokenHash !== "string") return undefined;
    // A new month starts the spend again, without anything having to run at midnight.
    if (typeof period === "string") return { name, capUsd, spentUsd: period === periodOf(now) ? spentUsd : 0, tokenHash, period: periodOf(now) };
    return { name, capUsd, spentUsd, tokenHash };
  } catch {
    return undefined;
  }
}

function keep(app: App, c: Credit): void {
  mkdirSync(join(app.config.dataDir, "credit"), { recursive: true });
  const p = path(app, c.name);
  writeFileSync(`${p}.tmp`, JSON.stringify(c), { mode: 0o600 });
  renameSync(`${p}.tmp`, p);
}

/**
 * Set a child's cap. When the child holds no bearer (the first time, or its
 * copy is lost) one is minted and `handOff` must put it in the child's hands
 * before anything is saved: if it cannot, nothing is, and the next call mints
 * again. The spend already counted is never reset. Undefined for a sum that
 * is not dollars; "unreachable" when the hand-off failed.
 */
export function setCap(
  app: App,
  name: string,
  usd: number,
  childHolds: boolean,
  handOff: (token: string, credit: Credit) => boolean,
  monthly = false,
): Credit | "unreachable" | undefined {
  if (!isChildName(name) || !(Number.isFinite(usd) && usd > 0 && usd <= CREDIT_MAX_USD)) return undefined;
  const before = readCredit(app, name);
  if (before !== undefined && childHolds) {
    const credit = { ...before, capUsd: cents(usd), ...(monthly ? { period: periodOf() } : {}) };
    keep(app, credit);
    return credit;
  }
  const token = `${name}.${randomBytes(24).toString("base64url")}`;
  const credit = { name, capUsd: cents(usd), spentUsd: before?.spentUsd ?? 0, tokenHash: sha(token), ...(monthly ? { period: periodOf() } : {}) };
  if (!handOff(token, credit)) return "unreachable";
  keep(app, credit);
  return credit;
}

/** The child a bearer was minted for, or undefined. The name rides in the bearer; the hash decides. */
export function creditOfToken(app: App, token: string): Credit | undefined {
  const name = token.split(".")[0] ?? "";
  const c = readCredit(app, name);
  if (c === undefined) return undefined;
  const a = Buffer.from(sha(token));
  const b = Buffer.from(c.tokenHash);
  return a.length === b.length && timingSafeEqual(a, b) ? c : undefined;
}

/** Count dollars spent against a child's cap. */
export function addSpend(app: App, name: string, usd: number): void {
  const c = readCredit(app, name);
  if (c === undefined || !(usd > 0) || !Number.isFinite(usd)) return;
  keep(app, { ...c, spentUsd: Math.round((c.spentUsd + usd) * 1e6) / 1e6 });
}

export const leftUsd = (c: Pick<Credit, "capUsd" | "spentUsd">): number => Math.max(0, cents(c.capUsd - c.spentUsd));

/** Whole dollars read plainly, others to the cent. */
export const usdWords = (n: number): string => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

/** The one sentence a call past the cap is refused with. */
export const spentWords = (name: string, capUsd: number): string =>
  `${name}'s ${usdWords(capUsd)} from its parent is spent; the parent's admin can raise it.`;

/** What the parent lists for a child: cap and spend to the cent, or nulls when no credit was set. */
export function creditView(app: App, name: string): { creditCapUsd: number | null; creditSpentUsd: number | null } {
  const c = readCredit(app, name);
  return c === undefined ? { creditCapUsd: null, creditSpentUsd: null } : { creditCapUsd: c.capUsd, creditSpentUsd: cents(c.spentUsd) };
}
