/**
 * Accounts an agent made by itself with the start call (`actions/start.ts`,
 * #10912), and where each is in its life. Pure data: no authz, no events.
 *
 * Unclaimed they are held small: no outbound host but the package registries,
 * a small app, no crew, and — after `SLEEP_DAYS` — asleep (suspended), then —
 * after `ARCHIVE_DAYS` — archived, never deleted. A person's claim ends all
 * of it. The claim link is kept as a sha256, like a token.
 */
import type { Database } from "bun:sqlite";
import { sha256 } from "../kernel/hash.ts";

export const SLEEP_DAYS = 7;
export const ARCHIVE_DAYS = 30;
const DAY_MS = 86_400_000;

/** What an unclaimed account's app may use: small, whatever forge.json says. */
export const SMALL_APP = { memoryMiB: 128, cpus: 0.25, diskMiB: 256 } as const;

export interface StartRow {
  readonly userId: string;
  readonly createdAt: string;
  readonly sleptAt: string | null;
  readonly archivedAt: string | null;
  readonly claimedAt: string | null;
  readonly claimedBy: string | null;
}

interface Raw {
  user_id: string;
  created_at: string;
  slept_at: string | null;
  archived_at: string | null;
  claimed_at: string | null;
  claimed_by: string | null;
}

const toRow = (r: Raw): StartRow => ({
  userId: r.user_id,
  createdAt: r.created_at,
  sleptAt: r.slept_at,
  archivedAt: r.archived_at,
  claimedAt: r.claimed_at,
  claimedBy: r.claimed_by,
});

/** A source (an address) is kept only as a hash: enough to count, never to read. */
export const sourceKey = (source: string): string => sha256(`start-source:${source}`).slice(0, 24);

export function recordStart(
  db: Database,
  userId: string,
  claimToken: string,
  source: string,
  at: Date = new Date(),
): void {
  db.query(
    "INSERT INTO start_account (user_id, claim_hash, source, created_at) VALUES (?1, ?2, ?3, ?4)",
  ).run(userId, sha256(claimToken), sourceKey(source), at.toISOString());
}

/** Starts made since `since`: from one source, or by everyone. */
export function startsSince(db: Database, since: Date, source?: string): number {
  const at = since.toISOString();
  const row =
    source === undefined
      ? db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM start_account WHERE created_at >= ?1").get(at)
      : db
          .query<{ n: number }, [string, string]>(
            "SELECT COUNT(*) AS n FROM start_account WHERE source = ?2 AND created_at >= ?1",
          )
          .get(at, sourceKey(source));
  return row?.n ?? 0;
}

export function startOfAccount(db: Database, userId: string): StartRow | undefined {
  const row = db.query<Raw, [string]>("SELECT * FROM start_account WHERE user_id = ?1").get(userId);
  return row === null ? undefined : toRow(row);
}

/** The row a claim link names, claimed or not. */
export function startByClaim(db: Database, claimToken: string): StartRow | undefined {
  const row = db
    .query<Raw, [string]>("SELECT * FROM start_account WHERE claim_hash = ?1")
    .get(sha256(claimToken));
  return row === null ? undefined : toRow(row);
}

/**
 * Burn the link for `claimedBy`, in the one statement that checks it: of two
 * people racing on one link, one wins.
 */
export function markClaimed(db: Database, userId: string, claimedBy: string, at: Date = new Date()): boolean {
  return (
    db
      .query(
        "UPDATE start_account SET claimed_at = ?1, claimed_by = ?2 WHERE user_id = ?3 AND claimed_at IS NULL",
      )
      .run(at.toISOString(), claimedBy, userId).changes === 1
  );
}

/** Whether the account is one an agent started that nobody has claimed. */
export function isUnclaimed(db: Database, userId: string): boolean {
  return (
    db
      .query<{ n: number }, [string]>("SELECT 1 AS n FROM start_account WHERE user_id = ?1 AND claimed_at IS NULL")
      .get(userId) !== null
  );
}

/**
 * A manifest as an unclaimed owner may run it: no host but the package
 * registries (the install steps add those themselves), and the small size
 * whatever `forge.json` asked for. A claimed or ordinary owner's passes whole.
 */
export function heldManifest<M extends { egress?: readonly string[] | undefined; limits?: object | undefined }>(
  db: Database,
  ownerId: string,
  manifest: M,
): M {
  if (!isUnclaimed(db, ownerId)) return manifest;
  const asked = (manifest.limits ?? {}) as Record<string, number | undefined>;
  const least = (key: keyof typeof SMALL_APP): number => Math.min(asked[key] ?? SMALL_APP[key], SMALL_APP[key]);
  return {
    ...manifest,
    egress: [],
    limits: { ...asked, memoryMiB: least("memoryMiB"), cpus: least("cpus"), diskMiB: least("diskMiB") },
  };
}

/** Unclaimed accounts made before `cutoff` that have not reached the stage yet. */
export function dueToSleep(db: Database, now: Date): string[] {
  const cutoff = new Date(now.getTime() - SLEEP_DAYS * DAY_MS).toISOString();
  return db
    .query<{ user_id: string }, [string]>(
      "SELECT user_id FROM start_account WHERE claimed_at IS NULL AND slept_at IS NULL AND created_at <= ?1",
    )
    .all(cutoff)
    .map((r) => r.user_id);
}

export function dueToArchive(db: Database, now: Date): string[] {
  const cutoff = new Date(now.getTime() - ARCHIVE_DAYS * DAY_MS).toISOString();
  return db
    .query<{ user_id: string }, [string]>(
      "SELECT user_id FROM start_account WHERE claimed_at IS NULL AND archived_at IS NULL AND created_at <= ?1",
    )
    .all(cutoff)
    .map((r) => r.user_id);
}

export function markSlept(db: Database, userId: string, at: Date): void {
  db.query("UPDATE start_account SET slept_at = ?1 WHERE user_id = ?2").run(at.toISOString(), userId);
}

export function markArchived(db: Database, userId: string, at: Date): void {
  db.query("UPDATE start_account SET archived_at = ?1, slept_at = COALESCE(slept_at, ?1) WHERE user_id = ?2").run(
    at.toISOString(),
    userId,
  );
}
