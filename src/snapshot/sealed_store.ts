/**
 * The off-site lane's store (#11805): a store whose every object is sealed
 * before it leaves the forge, so the bucket on neither machine holds only
 * ciphertext. The key is derived from the operator's passphrase
 * (`FORGE_SNAPSHOT_PASSPHRASE`) with scrypt under a random salt of the
 * lane's own, kept beside the objects in one unsealed header
 * (`sealed/lane.json`: the salt and a check value, never the key), so a
 * guess at the passphrase costs a scrypt per lane and nothing computed for
 * one lane opens another. The passphrase lives in the forge's environment
 * and with the operator, never in the repository and never on the bucket.
 *
 * Each body is AES-256-GCM under a fresh 12-byte IV (`FSO1`, IV, ciphertext,
 * tag), so a tampered object fails the tag and says so. Object names are
 * hidden too: everything after `snapshots/<name>/` is an HMAC of the path,
 * since a path names a repository. The snapshot's name (a UTC moment) stays
 * readable, so a listing still sorts, prunes and resumes. Everything sits
 * under `sealed/`, apart from anything written there before the lane sealed.
 *
 * Plain data in, plain data out; the inner store does the I/O.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { Store } from "./store.ts";

export const SEALED_PREFIX = "sealed/";
const MAGIC = Buffer.from("FSO1");
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** The lane's header, beside the sealed objects and unsealed: the salt and a check value, never the key. */
export const LANE_HEADER = `${SEALED_PREFIX}lane.json`;
const SALT_BYTES = 16;
const SALT_HEX = /^[0-9a-f]{32}$/;
const CHECK_HEX = /^[0-9a-f]{64}$/;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const HASHED = /^[0-9a-f]{64}$/;
const IN_SNAPSHOT = /^(snapshots\/[^/]+\/)(.+)$/;

export interface SealKeys {
  readonly enc: Buffer;
  readonly mac: Buffer;
}

/** The two keys a passphrase gives under a lane's salt: one seals bodies, one hides names. One scrypt, about 100 ms, off the main thread. */
export function sealKeys(passphrase: string, salt: Uint8Array): Promise<SealKeys> {
  return new Promise((resolve, reject) => {
    scrypt(passphrase, salt, 64, SCRYPT, (error, k) => {
      if (error) reject(error);
      else resolve({ enc: k.subarray(0, 32), mac: k.subarray(32) });
    });
  });
}

/** What the header keeps to tell the right passphrase from a wrong one; an HMAC, so it gives no shortcut past scrypt. */
const checkOf = (keys: SealKeys): string => createHmac("sha256", keys.mac).update("forge off-site lane header").digest("hex");

/** A header's salt and check, or a sentence when the object is not one the lane wrote. */
export function parseHeader(body: Uint8Array): { salt: Buffer; check: string } | string {
  try {
    const v = JSON.parse(new TextDecoder().decode(body)) as { v?: unknown; salt?: unknown; check?: unknown };
    if (v.v !== 1 || typeof v.salt !== "string" || !SALT_HEX.test(v.salt) || typeof v.check !== "string" || !CHECK_HEX.test(v.check))
      return `${LANE_HEADER} is not a lane header`;
    return { salt: Buffer.from(v.salt, "hex"), check: v.check };
  } catch {
    return `${LANE_HEADER} is not a lane header`;
  }
}

/**
 * The lane's keys: from its header's salt, checked, when the lane has one;
 * else, when `create`, a new random salt kept as the header first. A wrong
 * passphrase throws here, before any object is read or written.
 */
export async function laneKeys(inner: Store, passphrase: string, create: boolean): Promise<SealKeys> {
  const body = await inner.get(LANE_HEADER);
  if (body === undefined) {
    if (!create) throw new Error(`${inner.where} holds no sealed lane (no ${LANE_HEADER})`);
    const salt = randomBytes(SALT_BYTES);
    const keys = await sealKeys(passphrase, salt);
    await inner.put(LANE_HEADER, JSON.stringify({ v: 1, salt: salt.toString("hex"), check: checkOf(keys) }));
    return keys;
  }
  const h = parseHeader(body);
  if (typeof h === "string") throw new Error(h);
  const keys = await sealKeys(passphrase, h.salt);
  if (!timingSafeEqual(Buffer.from(checkOf(keys), "hex"), Buffer.from(h.check, "hex")))
    throw new Error(`the passphrase does not open the lane at ${inner.where}`);
  return keys;
}

export function sealBody(keys: SealKeys, body: Uint8Array | string): Uint8Array {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keys.enc, iv, { authTagLength: TAG_BYTES });
  const plain = typeof body === "string" ? Buffer.from(body) : body;
  return Buffer.concat([MAGIC, iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

/** The plain body; throws, naming the key, when the passphrase is wrong or the object is not one the lane sealed. */
export function openBody(keys: SealKeys, sealed: Uint8Array, key: string): Uint8Array {
  const b = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  if (b.length < MAGIC.length + IV_BYTES + TAG_BYTES || !b.subarray(0, MAGIC.length).equals(MAGIC))
    throw new Error(`${key} is not a sealed object`);
  const iv = b.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", keys.enc, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(b.subarray(b.length - TAG_BYTES));
  try {
    return new Uint8Array(Buffer.concat([decipher.update(b.subarray(MAGIC.length + IV_BYTES, b.length - TAG_BYTES)), decipher.final()]));
  } catch {
    throw new Error(`${key} did not open: wrong passphrase, or the object was changed`);
  }
}

/**
 * A key as the lane sees it: `snapshots/<name>/<hmac>`. A key already in
 * that form (as `list` returns it) is left as it is, so a listed key can be
 * read and deleted.
 */
export function hiddenKey(keys: SealKeys, key: string): string {
  const hide = (path: string): string => (HASHED.test(path) ? path : createHmac("sha256", keys.mac).update(path).digest("hex"));
  const m = IN_SNAPSHOT.exec(key);
  return m ? `${m[1]}${hide(m[2]!)}` : hide(key);
}

export interface SealedOptions {
  /** Whether a lane with no header yet starts one (the mirror pass); a restore reads, so it does not. */
  readonly create?: boolean;
}

/** `inner`, every object sealed under `passphrase` and named so a path never shows. The keys are derived on first use. */
export function sealedStore(inner: Store, passphrase: string, options: SealedOptions = {}): Store {
  let pending: Promise<SealKeys> | undefined;
  // One derivation for the store and every bounded view of it; a failed read of the header is tried again next time.
  const keys = (): Promise<SealKeys> =>
    (pending ??= laneKeys(inner, passphrase, options.create ?? true).catch((error: unknown) => {
      pending = undefined;
      throw error;
    }));
  return over(inner, keys);
}

function over(inner: Store, keys: () => Promise<SealKeys>): Store {
  const at = async (key: string): Promise<string> => SEALED_PREFIX + hiddenKey(await keys(), key);
  const store: Store = {
    where: `${inner.where} (sealed)`,
    sealed: true,
    async put(key, body) {
      const k = await keys();
      await inner.put(SEALED_PREFIX + hiddenKey(k, key), sealBody(k, body));
    },
    async get(key) {
      const k = await keys();
      const body = await inner.get(SEALED_PREFIX + hiddenKey(k, key));
      return body === undefined ? undefined : openBody(k, body, key);
    },
    async list(prefix) {
      await keys();
      return (await inner.list(SEALED_PREFIX + prefix)).map((k) => k.slice(SEALED_PREFIX.length));
    },
    async names(prefix) {
      await keys();
      return inner.names(SEALED_PREFIX + prefix);
    },
    async delete(key) {
      await inner.delete(await at(key));
    },
    storedKey: async (key) => hiddenKey(await keys(), key),
  };
  const bounded = inner.bounded;
  return bounded === undefined ? store : { ...store, bounded: (leftMs) => over(bounded.call(inner, leftMs), keys) };
}

/** A lane that may not write: every call fails with `reason`, so the board says why and nothing leaves unsealed. */
export function refusingStore(where: string, reason: string): Store {
  const no = async (): Promise<never> => {
    throw new Error(reason);
  };
  return { where, put: no, get: no, list: no, names: no, delete: no };
}
