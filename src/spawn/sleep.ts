/**
 * Hosted forges that scale to zero: how long a forge may be quiet before it
 * sleeps, how many may be awake at once, and how often one may be woken. Each
 * is declared by an environment variable with a default. How many forges, and
 * how much storage, a person may have are admin limits (`/admin/limits`), not
 * environment. Each refusal is a sentence a person can read. A sleeping forge
 * keeps its data on disk (`children/<bodyId>`); only its process goes.
 *
 * `heldByPerson` walks and stats the files of the person's forges
 * synchronously on the spawn request; it runs only after the count check
 * passes, and spawning is rare.
 */

import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { limitValue } from "../settings/limits.ts";

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
  /**
   * Seconds until `key` (a person) may wake another forge, 0 when it may now:
   * `max` wakes in any hour; the oldest leaves the window at its time + 1 h.
   */
  waitS(key: string, max: number, now = Date.now()): number {
    const r = this.recent(key, now);
    if (r.length < max) return 0;
    const free = (r[r.length - max] as number) + HOUR_MS;
    return Math.max(1, Math.ceil((free - now) / 1000));
  }
  note(bodyId: string, now = Date.now()): void {
    this.recent(bodyId, now).push(now);
  }
}

/** Why this host will not wake one more forge while `awake` are running, or undefined. */
export function awakeRefusal(awake: number, env: Env = process.env): string | undefined {
  const max = awakeCeiling(env);
  return awake >= max
    ? "the forge is full, try again shortly"
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

/** The ledger lines this person made: the forge name and its body id. */
function ownedLedgers(dataDir: string, ownerId: string): { name: string; bodyId: string }[] {
  const found: { name: string; bodyId: string }[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(join(dataDir, "spawn"));
  } catch {
    return found;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const l = JSON.parse(readFileSync(join(dataDir, "spawn", f), "utf8")) as { ownerId?: unknown; bodyId?: unknown };
      if (l.ownerId === ownerId && typeof l.bodyId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(l.bodyId))
        found.push({ name: f.slice(0, -5), bodyId: l.bodyId });
    } catch {
      // a damaged ledger counts for no one
    }
  }
  return found;
}

/** Bytes under a directory, files only. */
function bytesUnder(dir: string): number {
  let n = 0;
  try {
    for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (e.isFile()) n += statSync(join(e.parentPath, e.name), { throwIfNoEntry: false })?.size ?? 0;
    }
  } catch {
    // a forge with no data yet holds nothing
  }
  return n;
}

/** What this person's forges hold on disk, in bytes. */
export function heldByPerson(dataDir: string, ownerId: string): number {
  return ownedLedgers(dataDir, ownerId).reduce((sum, l) => sum + bytesUnder(join(dataDir, "children", l.bodyId)), 0);
}

const MB = 1_000_000;

/**
 * Why this person may not make another forge, or undefined: one sentence
 * naming the limit (set in admin limits) and what they use. Site admins are
 * not limited.
 */
export function personRefusal(db: Database, dataDir: string, owner: { id: string; isAdmin: boolean }): string | undefined {
  if (owner.isAdmin) return undefined;
  const max = limitValue(db, "forges.per_person");
  const has = ownedBy(dataDir, owner.id);
  if (has >= max) return `you already have ${has} ${has === 1 ? "forge" : "forges"}, the most one person may have (${max}); remove one first`;
  const maxMb = limitValue(db, "forges.storage_mb");
  const held = heldByPerson(dataDir, owner.id);
  if (held >= maxMb * MB)
    return `your forges already hold ${Math.ceil(held / MB)} MB, the most one person's forges may hold (${maxMb} MB); remove one first`;
  return undefined;
}

/** The plain-text "waking up" or refusal answer: for a git client or an API call (a page is `web/pages/waking.ts`). */
export function wakingText(name: string, why?: string, retryS = 5): Response {
  const message = why ?? `${name} was asleep and is waking up; this takes a few seconds`;
  return new Response(message, {
    status: why === undefined ? 503 : 429,
    headers: { "retry-after": String(retryS), "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
  });
}
