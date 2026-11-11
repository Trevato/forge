/**
 * Where a buyer pays for a hosted forge, one link a size (#11149). Stored as
 * JSON in `forge_setting` under `billing.links`, every change kept with who
 * and when; empty by default, and a child forge's database starts without it,
 * so only the forge that set links shows them. A bridge until the forge's own
 * checkout replaces it: the buyer pays at the link, the operator makes the forge.
 */

import type { Database } from "bun:sqlite";
import { err, ok, type Result } from "../kernel/result.ts";
import { SIZES, type Size } from "../spawn/sizes.ts";
import { writeSetting } from "./limits.ts";

export const BILLING_SIZES = ["small", "medium", "large"] as const satisfies readonly Size[];
export type BillingLinks = Partial<Record<Size, string>>;

export const BILLING_LINKS_KEY = "billing.links";
const MAX_URL = 300;

export const BILLING_WORDS = "billing links are an object of small, medium and large, each an https URL or empty";

/** One https URL with no credentials and no spaces, or the empty string. */
function parseLink(raw: unknown): string | undefined {
  if (raw === null || raw === "") return "";
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (s.length > MAX_URL || /[\s"'<>\\]/.test(s)) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && u.username === "" && u.password === "" && u.hostname !== "" ? s : undefined;
  } catch {
    return undefined;
  }
}

/** Links from untrusted input: only the three sizes, empty ones dropped; anything else is refused. */
export function parseBillingLinks(raw: unknown): Result<BillingLinks, "invalid_billing_links"> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return err("invalid_billing_links");
  const out: BillingLinks = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!(BILLING_SIZES as readonly string[]).includes(key)) return err("invalid_billing_links");
    const link = parseLink(value);
    if (link === undefined) return err("invalid_billing_links");
    if (link !== "") out[key as Size] = link;
  }
  return ok(out);
}

export function getBillingLinks(db: Database): BillingLinks {
  const row = db
    .query<{ value: string }, [string]>("SELECT value FROM forge_setting WHERE key = ?1")
    .get(BILLING_LINKS_KEY);
  return row === null ? {} : decodeLinks(row.value);
}

/** A stored links value as links; anything that does not parse reads as none. */
export function decodeLinks(raw: string): BillingLinks {
  try {
    const parsed = parseBillingLinks(JSON.parse(raw));
    return parsed.ok ? parsed.value : {};
  } catch {
    return {};
  }
}

const ENCODE = (links: BillingLinks): string =>
  JSON.stringify(Object.fromEntries(BILLING_SIZES.flatMap((s) => (links[s] === undefined ? [] : [[s, links[s]]]))));

/** Replace the links and keep the change; the same links again keep nothing; none at all clears the row. */
export function setBillingLinks(db: Database, value: BillingLinks, actorId: string): void {
  const from = ENCODE(getBillingLinks(db));
  const to = ENCODE(value);
  if (from === to) return;
  writeSetting(db, BILLING_LINKS_KEY, to === "{}" ? null : to, from, to, actorId);
}

/** The size in plain words, from the one table of sizes: "1 CPU, 2 GB memory, 2 GB disk". */
export function sizeWords(size: Size): string {
  const s = SIZES[size];
  const gb = (mib: number): string => `${mib / 1024} GB`;
  return `${s.cpu} ${s.cpu === 1 ? "CPU" : "CPUs"}, ${gb(s.memoryMiB)} memory, ${gb(s.diskMiB)} disk`;
}
