/**
 * Gift codes (#11157): the store. A code is short, typed easily and
 * unguessable (`forge-7kq4-m2xp`: 8 characters of a 31-letter alphabet, about
 * 40 bits, with redemption rate-limited per client). Only its SHA-256 is
 * kept; the plain code is shown once to the admin who made it. A use is
 * claimed in one statement, so two visitors cannot share the last use. Pure
 * data; authorization is in `actions/codes.ts`.
 */

import type { Database } from "bun:sqlite";
import { err, ok, type Result } from "../kernel/result.ts";

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const SHAPE = /^forge-[a-z0-9]{4}-[a-z0-9]{4}$/;
export const MAX_USES = 1000;
export const MAX_NOTE = 80;

export type CodeRefusal = "unknown" | "used_up" | "expired" | "revoked";

export const CODE_WORDS: Record<CodeRefusal, string> = {
  unknown: "That code is not one this forge knows",
  used_up: "That code has been used as many times as it allows",
  expired: "That code has expired",
  revoked: "That code was cancelled",
};

export interface Code {
  readonly id: string;
  readonly plan: string;
  readonly note: string;
  readonly uses: number;
  readonly used: number;
  readonly expiresAt?: string;
  readonly revokedAt?: string;
  readonly madeBy: string;
  readonly madeAt: string;
}

export interface Redeemed {
  readonly forge: string;
  readonly at: string;
}

interface Row {
  id: string; plan: string; note: string; uses: number; used: number; expires_at: string | null;
  revoked_at: string | null; made_by: string; made_at: string;
}

const fromRow = (r: Row): Code => ({
  id: r.id, plan: r.plan, note: r.note, uses: r.uses, used: r.used,
  ...(r.expires_at === null ? {} : { expiresAt: r.expires_at }),
  ...(r.revoked_at === null ? {} : { revokedAt: r.revoked_at }),
  madeBy: r.made_by, madeAt: r.made_at,
});

/** What a person typed, as the code it means: trimmed, lowercased, and of the code's shape, else undefined. */
export function normalizeCode(input: unknown): string | undefined {
  if (typeof input !== "string" || input.length > 64) return undefined;
  const code = input.trim().toLowerCase();
  return SHAPE.test(code) ? code : undefined;
}

export const hashCode = (code: string): string => new Bun.CryptoHasher("sha256").update(`gift-code:${code}`).digest("hex");

function randomGroup(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

export interface NewCode {
  plan: string;
  note: string;
  uses: number;
  expiresAt?: string;
  madeBy: string;
}

/** Make a code: its row (hashed) and the plain code, which exists nowhere else. */
export function insertCode(db: Database, n: NewCode, now = new Date()): { code: string; row: Code } {
  const code = `forge-${randomGroup()}-${randomGroup()}`;
  const id = crypto.randomUUID().slice(0, 8);
  const at = now.toISOString();
  db.query(
    "INSERT INTO gift_code (id, hash, plan, note, uses, expires_at, made_by, made_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
  ).run(id, hashCode(code), n.plan, n.note, n.uses, n.expiresAt ?? null, n.madeBy, at);
  return { code, row: getCode(db, id)! };
}

export function getCode(db: Database, id: string): Code | undefined {
  const r = db.query<Row, [string]>("SELECT * FROM gift_code WHERE id = ?1").get(id);
  return r ? fromRow(r) : undefined;
}

const refusalOf = (c: Code, now: Date): CodeRefusal | undefined =>
  c.revokedAt !== undefined ? "revoked"
  : c.expiresAt !== undefined && Date.parse(c.expiresAt) <= now.getTime() ? "expired"
  : c.used >= c.uses ? "used_up"
  : undefined;

/** The code a person typed, if it can be used now; nothing is spent. */
export function lookupCode(db: Database, input: unknown, now = new Date()): Result<Code, CodeRefusal> {
  const code = normalizeCode(input);
  const r = code === undefined ? undefined : db.query<Row, [string]>("SELECT * FROM gift_code WHERE hash = ?1").get(hashCode(code));
  if (!r) return err("unknown");
  const c = fromRow(r);
  const why = refusalOf(c, now);
  return why === undefined ? ok(c) : err(why);
}

/** Spend one use, in one statement: the last use goes to one caller only. */
export function claimCode(db: Database, input: unknown, now = new Date()): Result<Code, CodeRefusal> {
  const seen = lookupCode(db, input, now);
  if (!seen.ok) return seen;
  const done = db
    .query(
      `UPDATE gift_code SET used = used + 1
       WHERE id = ?1 AND revoked_at IS NULL AND used < uses AND (expires_at IS NULL OR expires_at > ?2)`,
    )
    .run(seen.value.id, now.toISOString());
  if (done.changes === 0) return lookupCode(db, input, now);
  return ok({ ...seen.value, used: seen.value.used + 1 });
}

/** Give a use back: the forge it was for was not made. */
export function releaseCode(db: Database, id: string): void {
  db.query("UPDATE gift_code SET used = MAX(0, used - 1) WHERE id = ?1").run(id);
}

export function noteRedeemed(db: Database, id: string, forge: string, now = new Date()): void {
  db.query("INSERT INTO gift_redeem (code_id, forge, at) VALUES (?1, ?2, ?3)").run(id, forge, now.toISOString());
}

/** Revoke: no new use. Returns false when there is no such code or it was already revoked. */
export function revokeCode(db: Database, id: string, now = new Date()): boolean {
  return db.query("UPDATE gift_code SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL").run(id, now.toISOString()).changes > 0;
}

export interface Listed extends Code {
  readonly madeByName: string;
  readonly redeemed: readonly Redeemed[];
}

/** Newest first, with who redeemed each. */
export function listCodes(db: Database, limit = 200): Listed[] {
  const rows = db
    .query<Row & { name: string | null }, [number]>(
      "SELECT g.*, u.username AS name FROM gift_code g LEFT JOIN user u ON u.id = g.made_by ORDER BY g.made_at DESC, g.rowid DESC LIMIT ?1",
    )
    .all(limit);
  const redeemed = db.query<{ code_id: string; forge: string; at: string }, []>("SELECT code_id, forge, at FROM gift_redeem ORDER BY id").all();
  return rows.map((r) => ({
    ...fromRow(r),
    madeByName: r.name ?? "an admin",
    redeemed: redeemed.filter((x) => x.code_id === r.id).map((x) => ({ forge: x.forge, at: x.at })),
  }));
}

const WINDOW_MS = 10 * 60_000;
/** Attempts one client may make in the window, redemption or look alike. */
export const TRIES_PER_WINDOW = 10;

/** Count one attempt for this client; false when it has spent its window. A refused attempt is not counted. */
export function takeTry(db: Database, bucket: string, now = Date.now()): boolean {
  db.query("DELETE FROM gift_try WHERE at <= ?1").run(now - WINDOW_MS);
  const n = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM gift_try WHERE bucket = ?1").get(bucket)!.n;
  if (n >= TRIES_PER_WINDOW) return false;
  db.query("INSERT INTO gift_try (bucket, at) VALUES (?1, ?2)").run(bucket, now);
  return true;
}
