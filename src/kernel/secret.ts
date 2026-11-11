/**
 * Secrets at rest. The forge stores exactly one class of third-party
 * credential — an origin's access token — and it must survive a restart
 * without living in plaintext next to the index. One key file per data
 * directory (`<data>/secret.key`, 32 random bytes, mode 0600) seals every
 * token with AES-256-GCM.
 *
 * This is protection against a leaked database file, not against an attacker
 * who already owns the data directory: the key sits beside the db because a
 * self-hosted forge has nowhere else to put it. Losing the key file costs
 * you the tokens (reconnect the origin), never the repositories.
 *
 * Sealed values are opaque strings, base64url:
 *   `v2:<keyid>:<iv>:<ciphertext+tag>` — written today; keyid is the first
 *     8 hex of SHA-256(key), so a value names the key that sealed it;
 *   `v1:<iv>:<ciphertext+tag>` — written before rotation existed; still read.
 *
 * Rotation: the data directory may hold a previous key beside the current
 * one (`secret.key.old`, also 0600). `open` uses whichever key a v2 value
 * names; a v1 value tries the current key, then the previous one. Moving
 * `secret.key` to `secret.key.old` and restarting mints a fresh current key
 * while everything sealed under the old one keeps opening.
 *
 * Nothing here ever logs, throws, or otherwise reveals a plaintext.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { defect, ForgeError } from "./error.ts";
import { err, ok, type Result } from "./result.ts";

const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard nonce
const TAG_BYTES = 16;
const VERSION = "v2";
const LEGACY = "v1";
const KEY_ID = /^[0-9a-f]{8}$/;

/** A key and the id a sealed value names it by. */
export interface NamedKey {
  readonly id: string;
  readonly key: Buffer;
}

/** The keys `open` may use: the current one seals, the previous only opens. */
export interface KeyRing {
  readonly current: NamedKey;
  readonly previous: NamedKey | null;
}

/** Keys are read once per path: this is on the hot path of every sync tick. */
const keyCache = new Map<string, Buffer>();
const previousCache = new Map<string, NamedKey | null>();

export function secretKeyPath(dataDir: string): string {
  return join(dataDir, "secret.key");
}

export function previousKeyPath(dataDir: string): string {
  return join(dataDir, "secret.key.old");
}

/** First 8 hex of SHA-256(key): names a key without revealing it. */
export function keyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

// Fail closed rather than silently tightening it: a key file the rest of
// the machine can read has already been readable for however long it was
// wrong, and quietly chmod-ing it would hide that from the operator.
function refuseIfOpen(path: string): void {
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    defect(
      "secret.key_too_open",
      `${path} is mode ${mode.toString(8)}; it must be 0600 — fix the permissions and restart`,
    );
  }
}

/**
 * The previous key, when the operator kept one. Never created: an absent or
 * malformed `secret.key.old` simply means there is nothing older to open.
 */
function loadPrevious(dataDir: string): NamedKey | null {
  const path = previousKeyPath(dataDir);
  if (previousCache.has(path)) return previousCache.get(path)!;
  let previous: NamedKey | null = null;
  try {
    const raw = readFileSync(path);
    refuseIfOpen(path);
    if (raw.length === KEY_BYTES) previous = { id: keyId(raw), key: raw };
  } catch (error) {
    if (ForgeError.isInstance(error)) throw error;
  }
  previousCache.set(path, previous);
  return previous;
}

/** The current key and, when kept, the previous one. */
export function loadKeys(dataDir: string): KeyRing {
  const key = loadKey(dataDir);
  return { current: { id: keyId(key), key }, previous: loadPrevious(dataDir) };
}

/**
 * The data directory's key, created on first use. Written with the mode set
 * at creation AND re-applied, because umask can widen the initial mode.
 */
export function loadKey(dataDir: string): Buffer {
  const path = secretKeyPath(dataDir);
  const cached = keyCache.get(path);
  if (cached) return cached;

  let key: Buffer;
  try {
    const raw = readFileSync(path);
    refuseIfOpen(path);
    key = raw.length === KEY_BYTES ? raw : mint(path);
  } catch (error) {
    if (ForgeError.isInstance(error)) throw error;
    key = mint(path);
  }
  keyCache.set(path, key);
  return key;
}

function mint(path: string): Buffer {
  const key = randomBytes(KEY_BYTES);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, key, { mode: 0o600 });
  chmodSync(path, 0o600);
  return key;
}

/**
 * Encrypt a plaintext for storage. `aad` is bound into the authentication
 * tag without being encrypted: pass the owning row's id, and a ciphertext
 * copied from one row into another stops decrypting. An attacker with SQL
 * write access but no key cannot swap one account's token onto another.
 */
export function seal(dataDir: string, plain: string, aad: string): string {
  const key = loadKey(dataDir);
  return sealWith({ id: keyId(key), key }, plain, aad);
}

/** `seal` under a key the caller holds: how a rotation re-seals under a key not yet on disk. */
export function sealWith(named: NamedKey, plain: string, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", named.key, iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return `${VERSION}:${named.id}:${iv.toString("base64url")}:${body.toString("base64url")}`;
}

/** The key id a sealed value names: a v2 value's id, null for a v1 value or anything else. */
export function sealedKeyId(sealed: string): string | null {
  const parts = sealed.split(":");
  return parts.length === 4 && parts[0] === VERSION && KEY_ID.test(parts[1]!) ? parts[1]! : null;
}

export type OpenError = "bad_format" | "bad_key";

/**
 * Decrypt a sealed value. A wrong key, a tampered ciphertext, and a value
 * lifted from another row all come back as `bad_key` — never a throw, and
 * never a partial plaintext.
 */
export function open(
  dataDir: string,
  sealed: string,
  aad: string,
): Result<string, OpenError> {
  // Only a sealed-looking value costs a key read.
  if (!sealed.startsWith(`${LEGACY}:`) && !sealed.startsWith(`${VERSION}:`)) return err("bad_format");
  const ring = loadKeys(dataDir);
  return openWith(ring.previous ? [ring.current, ring.previous] : [ring.current], sealed, aad);
}

/**
 * `open` with the keys the caller holds, tried in order for a v1 value; a
 * v2 value opens only with the key it names.
 */
export function openWith(
  keys: readonly NamedKey[],
  sealed: string,
  aad: string,
): Result<string, OpenError> {
  const parts = sealed.split(":");
  let candidates: Buffer[];
  let ivText: string;
  let bodyText: string;
  if (parts.length === 3 && parts[0] === LEGACY) {
    // A v1 value does not say which key sealed it: the current one first,
    // then the previous, so a rotation does not strand values from before.
    candidates = keys.map((k) => k.key);
    ivText = parts[1]!;
    bodyText = parts[2]!;
  } else if (parts.length === 4 && parts[0] === VERSION && KEY_ID.test(parts[1]!)) {
    const named = keys.find((k) => k.id === parts[1]);
    // The value names a key this directory no longer holds.
    if (!named) return err("bad_key");
    candidates = [named.key];
    ivText = parts[2]!;
    bodyText = parts[3]!;
  } else {
    return err("bad_format");
  }
  const iv = Buffer.from(ivText, "base64url");
  const body = Buffer.from(bodyText, "base64url");
  if (iv.length !== IV_BYTES || body.length <= TAG_BYTES)
    return err("bad_format");

  const tag = body.subarray(body.length - TAG_BYTES);
  const ciphertext = body.subarray(0, body.length - TAG_BYTES);
  for (const key of candidates) {
    const plain = decrypt(key, iv, ciphertext, tag, aad);
    if (plain !== null) return ok(plain);
  }
  return err("bad_key");
}

function decrypt(
  key: Buffer,
  iv: Buffer,
  ciphertext: Buffer,
  tag: Buffer,
  aad: string,
): string | null {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return plain.toString("utf8");
  } catch {
    // A failed tag check is the only outcome here, and it says nothing about
    // the plaintext — exactly the property we want.
    return null;
  }
}

/** Test seam: drop the cached key so a rewritten key file is picked up. */
export function forgetKey(dataDir: string): void {
  keyCache.delete(secretKeyPath(dataDir));
  previousCache.delete(previousKeyPath(dataDir));
}
