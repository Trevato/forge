/**
 * What a child knows of the credit its parent lends it (#10484): the bearer
 * the parent minted (`credit.token` in `parent.json`, beside the proposal
 * token, never in the database) and the cap and spend last heard. A funded
 * child's crew, with no account of its own granted, calls the model through
 * the parent's door (`FORGE_PARENT_LOCAL`); the parent's credential never
 * reaches this forge's environment or data directory, only the bearer that
 * is good for nothing but that door.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../app.ts";
import { leftUsd, usdWords } from "./credit.ts";
import { isParentLocal } from "./beat-door.ts";

export interface Funding {
  readonly token: string;
  readonly capUsd: number | null;
  readonly spentUsd: number | null;
}

const BEARER = /^[\x21-\x7e]{8,200}$/;
const file = (dataDir: string): string => join(dataDir, "parent.json");

function readDoc(dataDir: string): Record<string, unknown> | undefined {
  try {
    const d = JSON.parse(readFileSync(file(dataDir), "utf8"));
    return typeof d === "object" && d !== null && !Array.isArray(d) ? (d as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const sum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** The credit this forge was handed, or undefined. */
export function fundingOf(dataDir: string): Funding | undefined {
  const c = readDoc(dataDir)?.["credit"];
  if (typeof c !== "object" || c === null) return undefined;
  const { token, capUsd, spentUsd } = c as Record<string, unknown>;
  if (typeof token !== "string" || !BEARER.test(token)) return undefined;
  return { token, capUsd: sum(capUsd), spentUsd: sum(spentUsd) };
}

/** Write `credit` into a forge's `parent.json`, keeping the rest. The parent calls this on a child's directory. */
export function keepFunding(dataDir: string, funding: Funding): boolean {
  const doc = readDoc(dataDir);
  if (doc === undefined) return false;
  writeFileSync(`${file(dataDir)}.tmp`, JSON.stringify({ ...doc, credit: funding }), { mode: 0o600 });
  renameSync(`${file(dataDir)}.tmp`, file(dataDir));
  return true;
}

/** The environment that points a crew run at the parent's door; undefined unless funded and the door is reachable. */
export function fundedEnv(dataDir: string): Record<string, string> | undefined {
  const local = process.env["FORGE_PARENT_LOCAL"] ?? "";
  const f = fundingOf(dataDir);
  if (f === undefined || !isParentLocal(local)) return undefined;
  return { ANTHROPIC_BASE_URL: local, ANTHROPIC_API_KEY: f.token };
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Ask the parent how much is left and keep the answer; the last known stands when it does not answer. Never throws. */
export async function refreshFunding(app: App, fetcher: FetchLike = fetch): Promise<Funding | undefined> {
  const f = fundingOf(app.config.dataDir);
  const local = process.env["FORGE_PARENT_LOCAL"] ?? "";
  if (f === undefined) return undefined;
  if (!isParentLocal(local)) return f;
  try {
    const res = await fetcher(`${local}/api/v1/credit`, {
      headers: { authorization: `Bearer ${f.token}` },
      signal: AbortSignal.timeout(3000),
      redirect: "error",
    });
    if (!res.ok) return f;
    const d = (await res.json()) as Record<string, unknown>;
    const next = { token: f.token, capUsd: sum(d["capUsd"]), spentUsd: sum(d["spentUsd"]) };
    keepFunding(app.config.dataDir, next);
    return next;
  } catch {
    return f;
  }
}

/** The line the crew page and the API say: "funded by its parent: $199.50 of $200 left". */
export function fundingWords(f: Funding): string {
  return f.capUsd === null || f.spentUsd === null
    ? "funded by its parent"
    : `funded by its parent: ${usdWords(leftUsd({ capUsd: f.capUsd, spentUsd: f.spentUsd }))} of ${usdWords(f.capUsd)} left`;
}

/**
 * What is left of the credit the host lent this forge, when the run draws on
 * it (`draws`: no account of its own was picked); undefined otherwise.
 */
export function lentCreditLeft(draws: boolean, dataDir: string): number | undefined {
  if (!draws) return undefined;
  const f = fundingOf(dataDir);
  if (f === undefined || f.capUsd === null) return undefined;
  return Math.max(0, f.capUsd - (f.spentUsd ?? 0));
}

/** A run's budget in USD: what it asked for, never more than the lent credit left (#11948). */
export const cappedByLent = (wanted: number, lentLeft: number | undefined): number =>
  lentLeft === undefined ? wanted : Math.min(wanted, lentLeft);

/**
 * A run ended: when this forge is funded, ask the host what it counted, so the
 * credit line moves. The answer's promise when asked, undefined when not funded.
 */
export function runEnded(app: App, fetcher?: FetchLike): Promise<Funding | undefined> | undefined {
  if (fundingOf(app.config.dataDir) === undefined) return undefined;
  return refreshFunding(app, fetcher);
}
