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
 * Sealed values are opaque strings: `v1:<iv>:<ciphertext+tag>`, base64url.
 * Nothing here ever logs, throws, or otherwise reveals a plaintext.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
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
const VERSION = "v1";

/** Keys are read once per path: this is on the hot path of every sync tick. */
const keyCache = new Map<string, Buffer>();

export function secretKeyPath(dataDir: string): string {
  return join(dataDir, "secret.key");
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
    // Fail closed rather than silently tightening it: a key file the rest of
    // the machine can read has already been readable for however long it was
    // wrong, and quietly chmod-ing it would hide that from the operator.
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      defect(
        "secret.key_too_open",
        `${path} is mode ${mode.toString(8)}; it must be 0600 — fix the permissions and restart`,
      );
    }
    key = raw.length === KEY_BYTES ? raw : rotate(path);
  } catch (error) {
    if (ForgeError.isInstance(error)) throw error;
    key = rotate(path);
  }
  keyCache.set(path, key);
  return key;
}

function rotate(path: string): Buffer {
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
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", loadKey(dataDir), iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return `${VERSION}:${iv.toString("base64url")}:${body.toString("base64url")}`;
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
  const parts = sealed.split(":");
  if (parts.length !== 3 || parts[0] !== VERSION) return err("bad_format");
  const iv = Buffer.from(parts[1]!, "base64url");
  const body = Buffer.from(parts[2]!, "base64url");
  if (iv.length !== IV_BYTES || body.length <= TAG_BYTES)
    return err("bad_format");

  const tag = body.subarray(body.length - TAG_BYTES);
  const ciphertext = body.subarray(0, body.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", loadKey(dataDir), iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return ok(plain.toString("utf8"));
  } catch {
    // A failed tag check is the only outcome here, and it says nothing about
    // the plaintext — exactly the property we want.
    return err("bad_key");
  }
}

/** Test seam: drop the cached key so a rewritten key file is picked up. */
export function forgetKey(dataDir: string): void {
  keyCache.delete(secretKeyPath(dataDir));
}
