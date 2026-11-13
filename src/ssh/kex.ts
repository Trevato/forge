/**
 * The two pure computations of the key exchange, apart from the transport so
 * known answers can pin them: the exchange hash H (RFC 4253 §8, with the
 * curve25519 fields of RFC 8731 §3.1) and key derivation (RFC 4253 §7.2).
 * Both use SHA-256, the hash of `curve25519-sha256`.
 */

import { createHash } from "node:crypto";
import { sshString } from "./wire.ts";

export interface ExchangeHashInput {
  /** V_C and V_S: the version lines without CR LF. */
  clientVersion: Uint8Array;
  serverVersion: Uint8Array;
  /** I_C and I_S: the complete KEXINIT payloads, message byte included. */
  peerKexInit: Uint8Array;
  myKexInit: Uint8Array;
  /** K_S: the host key blob. */
  hostBlob: Uint8Array;
  /** Q_C and Q_S: the raw 32-byte X25519 public keys. */
  clientPublic: Uint8Array;
  serverPublic: Uint8Array;
  /** K as an SSH mpint, length prefix included. */
  kMpint: Uint8Array;
}

export function exchangeHashOf(i: ExchangeHashInput): Uint8Array {
  return new Uint8Array(
    createHash("sha256")
      .update(sshString(i.clientVersion))
      .update(sshString(i.serverVersion))
      .update(sshString(i.peerKexInit))
      .update(sshString(i.myKexInit))
      .update(sshString(i.hostBlob))
      .update(sshString(i.clientPublic))
      .update(sshString(i.serverPublic))
      .update(i.kMpint)
      .digest(),
  );
}

/** `HASH(K || H || letter || session_id)`, extended with `HASH(K || H || out)` to `length`. */
export function deriveKey(
  kMpint: Uint8Array,
  exchangeHash: Uint8Array,
  letter: string,
  sessionId: Uint8Array,
  length: number,
): Uint8Array {
  let out: Buffer = createHash("sha256")
    .update(kMpint)
    .update(exchangeHash)
    .update(letter)
    .update(sessionId)
    .digest();
  while (out.length < length) {
    out = Buffer.concat([
      out,
      createHash("sha256").update(kMpint).update(exchangeHash).update(out).digest(),
    ]);
  }
  return new Uint8Array(out.subarray(0, length));
}
