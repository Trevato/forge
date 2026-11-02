/**
 * SSH public keys. A key is stored as its wire blob (what an `authorized_keys`
 * line carries in base64) and indexed by the OpenSSH-style SHA256 fingerprint,
 * which is what the SSH listener looks up after a client proves possession.
 * Parsing is strict: the blob's inner type must match the declared type and
 * the encoded key must be exactly the size its algorithm dictates.
 */

import type { Database } from "bun:sqlite";
import { id } from "../kernel/id.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export const KEY_ALGOS = [
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "ssh-rsa",
] as const;
export type KeyAlgo = (typeof KEY_ALGOS)[number];

const MAX_LINE = 16 * 1024;
const MIN_RSA_BITS = 2048;
const EC_COORD_BYTES: Record<string, number> = {
  nistp256: 32,
  nistp384: 48,
  nistp521: 66,
};

export interface ParsedKey {
  readonly algo: KeyAlgo;
  readonly blob: Uint8Array;
  readonly comment: string;
}

export interface UserKey {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly algo: KeyAlgo;
  readonly fingerprint: string;
  /** The key as an `authorized_keys` line: `<algo> <base64>`. */
  readonly key: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

function isKeyAlgo(value: string): value is KeyAlgo {
  return (KEY_ALGOS as readonly string[]).includes(value);
}

/** A cursor over SSH wire encoding: length-prefixed strings and mpints. */
class Reader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  string(): Uint8Array | undefined {
    if (this.offset + 4 > this.bytes.length) return undefined;
    const view = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset,
      this.bytes.byteLength,
    );
    const length = view.getUint32(this.offset);
    this.offset += 4;
    if (this.offset + length > this.bytes.length) return undefined;
    const out = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  done(): boolean {
    return this.offset === this.bytes.length;
  }
}

/** Bit length of a positive SSH mpint (big-endian, possibly zero-padded). */
function mpintBits(mpint: Uint8Array): number {
  let i = 0;
  while (i < mpint.length && mpint[i] === 0) i++;
  if (i === mpint.length) return 0;
  const first = mpint[i]!;
  return (mpint.length - i - 1) * 8 + (32 - Math.clz32(first));
}

/** The blob's structure must be exactly what `algo` dictates — nothing more. */
function validBlob(algo: KeyAlgo, blob: Uint8Array): boolean {
  const reader = new Reader(blob);
  const inner = reader.string();
  if (!inner || new TextDecoder().decode(inner) !== algo) return false;
  if (algo === "ssh-ed25519") {
    const pub = reader.string();
    return pub !== undefined && pub.length === 32 && reader.done();
  }
  if (algo === "ssh-rsa") {
    const e = reader.string();
    const n = reader.string();
    return (
      e !== undefined &&
      n !== undefined &&
      mpintBits(e) > 1 &&
      mpintBits(n) >= MIN_RSA_BITS &&
      reader.done()
    );
  }
  const curve = reader.string();
  const point = reader.string();
  if (!curve || !point || !reader.done()) return false;
  const curveName = new TextDecoder().decode(curve);
  if (`ecdsa-sha2-${curveName}` !== algo) return false;
  const coord = EC_COORD_BYTES[curveName];
  return (
    coord !== undefined && point[0] === 4 && point.length === 1 + 2 * coord
  );
}

export function parseAuthorizedKey(
  line: string,
): Result<ParsedKey, "invalid_key"> {
  if (line.length > MAX_LINE) return err("invalid_key");
  const parts = line.trim().split(/\s+/);
  const [type, b64, ...rest] = parts;
  if (!type || !b64 || !isKeyAlgo(type)) return err("invalid_key");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return err("invalid_key");
  const blob = new Uint8Array(Buffer.from(b64, "base64"));
  // A lenient decoder would accept junk; round-tripping makes it strict.
  if (Buffer.from(blob).toString("base64") !== b64) return err("invalid_key");
  if (!validBlob(type, blob)) return err("invalid_key");
  return ok({ algo: type, blob, comment: rest.join(" ") });
}

/** OpenSSH's `SHA256:` fingerprint — base64 of the blob's digest, unpadded. */
export function fingerprint(blob: Uint8Array): string {
  const digest = new Bun.CryptoHasher("sha256").update(blob).digest();
  return `SHA256:${Buffer.from(digest).toString("base64").replace(/=+$/, "")}`;
}

interface KeyRow {
  id: string;
  user_id: string;
  name: string;
  algo: KeyAlgo;
  blob: string;
  fingerprint: string;
  created_at: string;
  last_used_at: string | null;
}

function toKey(row: KeyRow): UserKey {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    algo: row.algo,
    fingerprint: row.fingerprint,
    key: `${row.algo} ${row.blob}`,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

const SELECT = "SELECT * FROM user_key";

export function addKey(
  db: Database,
  userId: string,
  name: string,
  parsed: ParsedKey,
): Result<UserKey, "key_exists"> {
  const fp = fingerprint(parsed.blob);
  if (db.query("SELECT 1 FROM user_key WHERE fingerprint = ?1").get(fp))
    return err("key_exists");
  const keyId = id();
  db.query(
    `INSERT INTO user_key (id, user_id, name, algo, blob, fingerprint)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).run(
    keyId,
    userId,
    keyName(fitKeyName(name)) ?? parsed.algo,
    parsed.algo,
    Buffer.from(parsed.blob).toString("base64"),
    fp,
  );
  return ok(getKey(db, keyId)!);
}

function getKey(db: Database, keyId: string): UserKey | undefined {
  const row = db.query<KeyRow, [string]>(`${SELECT} WHERE id = ?1`).get(keyId);
  return row ? toKey(row) : undefined;
}

export function listKeys(db: Database, userId: string): UserKey[] {
  return db
    .query<KeyRow, [string]>(`${SELECT} WHERE user_id = ?1 ORDER BY created_at`)
    .all(userId)
    .map(toKey);
}

/** Delete one of `userId`'s keys. Returns the removed key, or undefined if
 * it wasn't theirs — another user's key id is indistinguishable from none. */
export function deleteKey(
  db: Database,
  userId: string,
  keyId: string,
): UserKey | undefined {
  const row = db
    .query<
      KeyRow,
      [string, string]
    >("DELETE FROM user_key WHERE id = ?1 AND user_id = ?2 RETURNING *")
    .get(keyId, userId);
  return row ? toKey(row) : undefined;
}

export const KEY_NAME_MAX = 64;

/** A key's name, trimmed, or undefined when it is not 1–64 printable
 * characters: no control or format characters, so a name cannot paint the
 * terminal it is drawn in. */
export function keyName(raw: string): string | undefined {
  const name = raw.trim();
  if (name.length === 0 || [...name].length > KEY_NAME_MAX) return undefined;
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) return undefined;
  return name;
}

/** `raw` made to pass `keyName` where it can: control and format characters
 * become spaces and the rest is cut to 64 characters. Adding a key fits the
 * name it is given (often the authorized_keys comment) rather than refusing
 * it, so every stored name is one a rename would accept. */
export function fitKeyName(raw: string): string {
  const spaced = raw.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").trim();
  return [...spaced].slice(0, KEY_NAME_MAX).join("").trim();
}

/** Rename one of `userId`'s keys. False, and nothing changed, when the name
 * is refused or the key is not theirs. */
export function renameKey(
  db: Database,
  userId: string,
  keyId: string,
  raw: string,
): boolean {
  const name = keyName(raw);
  if (name === undefined) return false;
  return (
    db
      .query("UPDATE user_key SET name = ?1 WHERE id = ?2 AND user_id = ?3")
      .run(name, keyId, userId).changes === 1
  );
}

export interface KeyMatch {
  readonly userId: string;
  readonly keyId: string;
  readonly algo: KeyAlgo;
  readonly blob: Uint8Array;
}

/** Look a presented key up by fingerprint. The caller must still verify the
 * signature against `blob` — this is a lookup, not an authentication. */
export function findKeyByFingerprint(
  db: Database,
  fp: string,
): KeyMatch | undefined {
  const row = db
    .query<KeyRow, [string]>(`${SELECT} WHERE fingerprint = ?1`)
    .get(fp);
  if (!row) return undefined;
  return {
    userId: row.user_id,
    keyId: row.id,
    algo: row.algo,
    blob: new Uint8Array(Buffer.from(row.blob, "base64")),
  };
}

export function touchKey(db: Database, keyId: string): void {
  db.query("UPDATE user_key SET last_used_at = ?1 WHERE id = ?2").run(
    new Date().toISOString(),
    keyId,
  );
}

/** What the API and MCP answer for a key: one shape for both. */
export function publicKey(key: UserKey) {
  return {
    id: key.id,
    name: key.name,
    algo: key.algo,
    fingerprint: key.fingerprint,
    key: key.key,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
  };
}
