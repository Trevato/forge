/**
 * Hosted forges that scale to zero: how long a forge may be quiet before it
 * sleeps, how many may be awake at once, how often one may be woken, and how
 * many a person may own. Each limit is declared by an environment variable
 * with a default, and each refusal is a sentence a person can read. A sleeping
 * forge keeps its data on disk (`children/<bodyId>`); only its process goes.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Env = Record<string, string | undefined>;

function whole(env: Env, name: string, fallback: number): number {
  const v = env[name];
  if (v === undefined || !/^[0-9]{1,9}$/.test(v)) return fallback;
  const n = Number(v);
  return n > 0 ? n : fallback;
}

/** A forge quiet for this long sleeps: FORGE_CHILD_IDLE_S, ten minutes by default. */
export const idleAfterMs = (env: Env = process.env): number => whole(env, "FORGE_CHILD_IDLE_S", 600) * 1000;
/** Most hosted forges awake at once on this host: FORGE_CHILD_AWAKE_MAX. A sleeping forge does not count. */
export const awakeCeiling = (env: Env = process.env): number => whole(env, "FORGE_CHILD_AWAKE_MAX", 8);
/** Most wakes of one forge in an hour: FORGE_CHILD_WAKES_PER_HOUR. */
export const wakesPerHour = (env: Env = process.env): number => whole(env, "FORGE_CHILD_WAKES_PER_HOUR", 20);
/** Most forges one person may own: FORGE_FORGES_PER_PERSON. */
export const forgesPerPerson = (env: Env = process.env): number => whole(env, "FORGE_FORGES_PER_PERSON", 3);

const HOUR_MS = 3_600_000;

/** Wakes per forge in the last hour; in memory, since a restart wakes nothing. */
export class WakeRate {
  private readonly at = new Map<string, number[]>();
  private recent(bodyId: string, now: number): number[] {
    const kept = (this.at.get(bodyId) ?? []).filter((t) => now - t < HOUR_MS);
    this.at.set(bodyId, kept);
    return kept;
  }
  /** Why this forge may not be woken now, or undefined. */
  refusal(bodyId: string, now = Date.now(), env: Env = process.env): string | undefined {
    const max = wakesPerHour(env);
    return this.recent(bodyId, now).length >= max
      ? `this forge has been woken ${max} times in the last hour, the most it may be; try again in a little while`
      : undefined;
  }
  note(bodyId: string, now = Date.now()): void {
    this.recent(bodyId, now).push(now);
  }
}

/** Why this host will not wake one more forge while `awake` are running, or undefined. */
export function awakeRefusal(awake: number, env: Env = process.env): string | undefined {
  const max = awakeCeiling(env);
  return awake >= max
    ? `${awake} forges are awake on this host right now, the most it runs at once; try again in a minute`
    : undefined;
}

/** How many forges, finished or begun, this person owns (the ledger's `ownerId`). */
export function ownedBy(dataDir: string, ownerId: string): number {
  let n = 0;
  let files: string[] = [];
  try {
    files = readdirSync(join(dataDir, "spawn"));
  } catch {
    return 0;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      if ((JSON.parse(readFileSync(join(dataDir, "spawn", f), "utf8")) as { ownerId?: unknown }).ownerId === ownerId) n++;
    } catch {
      // a damaged ledger counts for no one
    }
  }
  return n;
}

/** Why this person may not make another forge, or undefined. Site admins are not limited. */
export function personRefusal(dataDir: string, owner: { id: string; isAdmin: boolean }, env: Env = process.env): string | undefined {
  if (owner.isAdmin) return undefined;
  const max = forgesPerPerson(env);
  const has = ownedBy(dataDir, owner.id);
  return has >= max ? `you already have ${has} forges, the most one person may have (${max}); remove one first` : undefined;
}

/** The plain-text "waking up" or refusal answer: for a git client or an API call (a page is `web/pages/waking.ts`). */
export function wakingText(name: string, why?: string): Response {
  const message = why ?? `${name} was asleep and is waking up; this takes a few seconds`;
  return new Response(message, {
    status: why === undefined ? 503 : 429,
    headers: { "retry-after": "5", "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
  });
}
