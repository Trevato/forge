/**
 * SSH public keys: blob parsing into `node:crypto` KeyObjects, signature
 * verification, SHA-256 fingerprints, and the server's Ed25519 host key.
 *
 * Everything here is fed attacker-controlled bytes, so every function that
 * touches a peer blob returns a `Result` and never throws. The host-key
 * helpers are boot-time code operating on our own files: a failure there is a
 * defect, not an expected outcome.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { defect, ForgeError } from "../kernel/error.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { Reader, Writer } from "./wire.ts";

/** A client (or host) public key in the three forms callers need. */
export interface SshPublicKey {
  /**
   * The key blob's *own* algorithm name — `ssh-ed25519`,
   * `ecdsa-sha2-nistp256`, or `ssh-rsa` (RSA keys say `ssh-rsa` whatever
   * signature algorithm was used with them, per RFC 8332 §3).
   */
  algo: string;
  /** The raw public key blob: exactly what `authorized_keys` base64s. */
  blob: Uint8Array;
  /** `SHA256:<base64 of sha256(blob), '=' stripped>` — OpenSSH's format. */
  fingerprint: string;
  /** `"<algo> <base64>"` — an `authorized_keys` line without a comment. */
  line: string;
}

/** Public key algorithm names we accept from clients. `ssh-rsa` (SHA-1) and
 *  `ssh-dss` are deliberately absent. */
export const ACCEPTED_KEY_ALGOS = [
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "rsa-sha2-256",
  "rsa-sha2-512",
] as const;

/** The value of the EXT_INFO `server-sig-algs` extension (RFC 8308 §3.1).
 *  Without it an RSA-only client offers `ssh-rsa`, we reject the SHA-1
 *  signature, and the user sees a bare "Permission denied (publickey)". */
export const SERVER_SIG_ALGS = ACCEPTED_KEY_ALGOS.join(",");

const CURVES: Record<string, { jwk: string; size: number; hash: string }> = {
  "ecdsa-sha2-nistp256": { jwk: "P-256", size: 32, hash: "sha256" },
  "ecdsa-sha2-nistp384": { jwk: "P-384", size: 48, hash: "sha384" },
  "ecdsa-sha2-nistp521": { jwk: "P-521", size: 66, hash: "sha512" },
};

const RSA_MIN_BITS = 2048;
const RSA_MAX_BITS = 16384;

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function stripLeadingZeros(bytes: Uint8Array): Uint8Array {
  let at = 0;
  while (at < bytes.length - 1 && bytes[at] === 0) at++;
  return bytes.subarray(at);
}

/** OpenSSH's `FingerprintHash sha256` output, over the blob (not the base64). */
export function fingerprintOf(blob: Uint8Array): string {
  const digest = createHash("sha256").update(blob).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

/** The `authorized_keys` / `known_hosts` one-liner, comment omitted. */
export function keyLine(algo: string, blob: Uint8Array): string {
  return `${algo} ${Buffer.from(blob).toString("base64")}`;
}

/**
 * Parse a public key blob into a verifying key. Also yields the blob's inner
 * algorithm name, which is the key's durable identity.
 */
export function parsePublicKeyBlob(
  blob: Uint8Array,
): Result<{ algo: string; key: KeyObject }, string> {
  try {
    const r = new Reader(blob);
    const algo = r.text();
    if (algo === "ssh-ed25519") {
      const raw = r.string();
      r.end();
      if (raw.length !== 32) return err("ed25519 key is not 32 bytes");
      const key = createPublicKey({
        key: { kty: "OKP", crv: "Ed25519", x: b64url(raw) },
        format: "jwk",
      });
      return ok({ algo, key });
    }
    const curve = CURVES[algo];
    if (curve) {
      // The curve identifier is a *separate, shorter* string than the
      // algorithm name — `nistp256`, not `ecdsa-sha2-nistp256`.
      const named = r.text();
      const point = r.string();
      r.end();
      if (named !== algo.slice("ecdsa-sha2-".length)) {
        return err(`curve ${named} does not match ${algo}`);
      }
      // OpenSSH neither accepts nor generates point-compressed encodings.
      if (point.length !== 1 + curve.size * 2 || point[0] !== 0x04) {
        return err("ecdsa point is not an uncompressed SEC1 point");
      }
      const key = createPublicKey({
        key: {
          kty: "EC",
          crv: curve.jwk,
          x: b64url(point.subarray(1, 1 + curve.size)),
          y: b64url(point.subarray(1 + curve.size)),
        },
        format: "jwk",
      });
      return ok({ algo, key });
    }
    if (algo === "ssh-rsa") {
      const e = stripLeadingZeros(r.string());
      const n = stripLeadingZeros(r.string());
      r.end();
      const bits = n.length * 8;
      if (bits < RSA_MIN_BITS) return err(`rsa modulus too small (${bits})`);
      if (bits > RSA_MAX_BITS) return err(`rsa modulus too large (${bits})`);
      // JWK wants minimal big-endian integers: the mpint sign byte must go.
      const key = createPublicKey({
        key: { kty: "RSA", n: b64url(n), e: b64url(e) },
        format: "jwk",
      });
      return ok({ algo, key });
    }
    return err(`unsupported key type ${algo}`);
  } catch (cause) {
    return err(`malformed key blob: ${String(cause)}`);
  }
}

/** Parse a blob and package it as an `SshPublicKey`. */
export function publicKeyFromBlob(
  blob: Uint8Array,
): Result<SshPublicKey, string> {
  const parsed = parsePublicKeyBlob(blob);
  if (!parsed.ok) return parsed;
  return ok({
    algo: parsed.value.algo,
    blob,
    fingerprint: fingerprintOf(blob),
    line: keyLine(parsed.value.algo, blob),
  });
}

/**
 * Does public-key algorithm `outer` (as named in USERAUTH_REQUEST) pair with
 * a blob whose inner name is `inner`? Identical except for RFC 8332: an RSA
 * blob always says `ssh-rsa` even under `rsa-sha2-256`/`-512`.
 */
export function keyAlgorithmMatches(outer: string, inner: string): boolean {
  if (outer === inner) return true;
  return (
    inner === "ssh-rsa" &&
    (outer === "rsa-sha2-256" || outer === "rsa-sha2-512")
  );
}

/**
 * Verify an SSH signature blob over `message` with the key in `keyBlob`.
 * `algo` is the algorithm named by the request; it must match both the key
 * and the signature blob's own name, so a client cannot downgrade an
 * `rsa-sha2-512` offer into a SHA-1 signature.
 */
export function verifySshSignature(
  algo: string,
  keyBlob: Uint8Array,
  sigBlob: Uint8Array,
  message: Uint8Array,
): Result<true, string> {
  if (!(ACCEPTED_KEY_ALGOS as readonly string[]).includes(algo)) {
    return err(`signature algorithm ${algo} not accepted`);
  }
  const parsed = parsePublicKeyBlob(keyBlob);
  if (!parsed.ok) return parsed;
  if (!keyAlgorithmMatches(algo, parsed.value.algo)) {
    return err(`key type ${parsed.value.algo} does not match ${algo}`);
  }
  try {
    const r = new Reader(sigBlob);
    const sigAlgo = r.text();
    const signature = r.string();
    r.end();
    if (sigAlgo !== algo) {
      return err(`signature says ${sigAlgo}, request says ${algo}`);
    }
    const key = parsed.value.key;
    if (algo === "ssh-ed25519") {
      if (signature.length !== 64)
        return err("ed25519 signature is not 64 bytes");
      // Pure EdDSA: no prehash, so the algorithm argument is null.
      return cryptoVerify(null, message, key, signature)
        ? ok(true)
        : err("bad ed25519 signature");
    }
    const curve = CURVES[algo];
    if (curve) {
      // Two nesting levels: the signature `string` itself holds `mpint r`,
      // `mpint s`. Node's ieee-p1363 encoding wants them fixed-width at the
      // curve's coordinate size, so strip the mpint sign byte and left-pad.
      const inner = new Reader(signature);
      const rs = new Uint8Array(curve.size * 2);
      for (let half = 0; half < 2; half++) {
        const value = stripLeadingZeros(inner.string());
        if (value.length > curve.size) return err("ecdsa scalar too large");
        rs.set(value, half * curve.size + (curve.size - value.length));
      }
      inner.end();
      return cryptoVerify(
        curve.hash,
        message,
        { key, dsaEncoding: "ieee-p1363" },
        rs,
      )
        ? ok(true)
        : err("bad ecdsa signature");
    }
    // rsa-sha2-*: RSASSA-PKCS1-v1_5, which is node's default padding.
    const hash = algo === "rsa-sha2-512" ? "sha512" : "sha256";
    return cryptoVerify(hash, message, key, signature)
      ? ok(true)
      : err("bad rsa signature");
  } catch (cause) {
    return err(`signature verification failed: ${String(cause)}`);
  }
}

/** The server's Ed25519 host key: private half plus its public forms. */
export interface HostKey {
  readonly privateKey: KeyObject;
  readonly publicKey: SshPublicKey;
}

function ed25519Blob(privateKey: KeyObject): Uint8Array {
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  if (typeof jwk.x !== "string") {
    defect("ssh.host_key", "ed25519 public key has no JWK x coordinate");
  }
  const raw = Buffer.from(jwk.x, "base64url");
  if (raw.length !== 32) {
    defect("ssh.host_key", `ed25519 public key is ${raw.length} bytes`);
  }
  return new Writer(64).string("ssh-ed25519").string(raw).build();
}

/**
 * Load `<dir>/host_ed25519`, generating it on first boot.
 *
 * The private half is a PKCS#8 PEM — `node:crypto` round-trips that natively,
 * where OpenSSH's own private format is a bespoke bcrypt-KDF container worth
 * ~150 lines for no runtime benefit. Alongside it we write `host_ed25519.pub`
 * in `authorized_keys` form, which is what `ssh-keygen -lf` actually reads,
 * so an operator can confirm the fingerprint with the standard tool.
 */
export function loadOrCreateHostKey(dir: string): HostKey {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "host_ed25519");
  let privateKey: KeyObject;
  try {
    const pem = readFileSync(path, "utf8");
    // Same refusal as secret.key: fail closed, never chmod it quietly.
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      defect(
        "ssh.host_key_too_open",
        `${path} is mode ${mode.toString(8)}; it must be 0600 — fix the permissions and restart`,
      );
    }
    privateKey = createPrivateKey(pem);
  } catch (cause) {
    if (ForgeError.isInstance(cause)) throw cause;
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
      defect("ssh.host_key", `cannot read host key at ${path}`, cause);
    }
    const pair = generateKeyPairSync("ed25519");
    const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" });
    // Write-then-rename so a crash mid-write cannot leave a truncated key.
    writeFileSync(`${path}.tmp`, pem, { mode: 0o600 });
    chmodSync(`${path}.tmp`, 0o600);
    renameSync(`${path}.tmp`, path);
    privateKey = pair.privateKey;
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    defect("ssh.host_key", `host key at ${path} is not ed25519`);
  }
  const blob = ed25519Blob(privateKey);
  const publicKey: SshPublicKey = {
    algo: "ssh-ed25519",
    blob,
    fingerprint: fingerprintOf(blob),
    line: keyLine("ssh-ed25519", blob),
  };
  writeFileSync(`${path}.pub`, `${publicKey.line} forge\n`, { mode: 0o644 });
  return { privateKey, publicKey };
}

/** Sign `message` with the host key, returning an `ssh-ed25519` signature blob. */
export function signWithHostKey(
  host: HostKey,
  message: Uint8Array,
): Uint8Array {
  const raw = cryptoSign(null, message, host.privateKey);
  return new Writer(128).string("ssh-ed25519").string(raw).build();
}
