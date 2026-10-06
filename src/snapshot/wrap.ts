/**
 * The forge's key, wrapped for a bucket: AES-256-GCM under a key stretched
 * from an operator's passphrase with scrypt. The passphrase lives in the
 * forge's environment (`FORGE_SNAPSHOT_PASSPHRASE`) and with the operator,
 * never in the bucket, so whoever reads the bucket holds the data without
 * the key that opens its sealed values.
 *
 * The wrapped form is one small JSON file:
 * `{"v":1,"kdf":"scrypt","salt":…,"iv":…,"ct":…}`, base64url. A wrong
 * passphrase and a tampered file both fail the tag check, and say so alike.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

export const WRAPPED_KEY = "secret.key.wrapped";

const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Interactive-grade cost: one derivation per snapshot, once a night. */
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

const derive = (passphrase: string, salt: Buffer): Buffer =>
  scryptSync(passphrase, salt, 32, SCRYPT);

export function wrapKey(key: Uint8Array, passphrase: string): string {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", derive(passphrase, salt), iv, {
    authTagLength: TAG_BYTES,
  });
  const ct = Buffer.concat([
    cipher.update(key),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return JSON.stringify({
    v: 1,
    kdf: "scrypt",
    salt: salt.toString("base64url"),
    iv: iv.toString("base64url"),
    ct: ct.toString("base64url"),
  });
}

/** The key, or undefined when the passphrase is wrong or the file is not ours. */
export function unwrapKey(
  wrapped: Uint8Array | string,
  passphrase: string,
): Buffer | undefined {
  try {
    const text =
      typeof wrapped === "string" ? wrapped : new TextDecoder().decode(wrapped);
    const w = JSON.parse(text) as Record<string, unknown>;
    if (w["v"] !== 1 || w["kdf"] !== "scrypt") return undefined;
    const salt = Buffer.from(String(w["salt"]), "base64url");
    const iv = Buffer.from(String(w["iv"]), "base64url");
    const ct = Buffer.from(String(w["ct"]), "base64url");
    if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES) return undefined;
    if (ct.length <= TAG_BYTES) return undefined;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      derive(passphrase, salt),
      iv,
      { authTagLength: TAG_BYTES },
    );
    decipher.setAuthTag(ct.subarray(ct.length - TAG_BYTES));
    return Buffer.concat([
      decipher.update(ct.subarray(0, ct.length - TAG_BYTES)),
      decipher.final(),
    ]);
  } catch {
    return undefined;
  }
}
