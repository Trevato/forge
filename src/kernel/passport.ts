/**
 * Short-lived scoped credentials between forge parts. One part (the issuer)
 * hands another a passport: who it is for (`audience`), what it may do
 * (`scopes`), and when it stops working (`exp`). The receiver verifies it
 * with no database lookup and no shared long-lived secret travelling on the
 * wire — a stolen passport is useful to one audience, for a few minutes,
 * for the listed scopes only.
 *
 * Format: `fp1.<payload>.<mac>`, payload base64url JSON, mac an HMAC-SHA256
 * over the payload keyed by a subkey derived from the data directory's
 * `secret.key` (HKDF, purpose "passport"), so it never reuses the key that
 * seals origin tokens.
 *
 * Pure but for the key read and the clock, which is passed in.
 */

import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { loadKey } from "./secret.ts";
import { err, ok, type Result } from "./result.ts";

const PREFIX = "fp1";
/** The longest a passport may live: a credential is minutes, not days. */
export const MAX_TTL_MS = 15 * 60_000;
const MAX_LEN = 2048;
const NAME = /^[a-z][a-z0-9_.:-]{0,63}$/;
const MAX_SCOPES = 16;

export type Passport = {
  /** The part that issued it. */
  readonly iss: string;
  /** The one part that may accept it. */
  readonly aud: string;
  readonly scopes: readonly string[];
  readonly exp: number;
};

export type IssueError = "bad_name" | "bad_scopes" | "bad_ttl";
export type VerifyError =
  | "bad_format"
  | "bad_signature"
  | "expired"
  | "wrong_audience"
  | "missing_scope";

const subkeys = new Map<string, { key: Buffer; derived: Buffer }>();

function subkey(dataDir: string): Buffer {
  const key = loadKey(dataDir);
  const hit = subkeys.get(dataDir);
  // Keyed on the loaded key: `loadKey` caches per process, so `forgetKey` or a restart picks up a rotation.
  if (hit?.key.equals(key)) return hit.derived;
  const derived = Buffer.from(
    hkdfSync("sha256", key, "", "forge passport v1", 32),
  );
  subkeys.set(dataDir, { key, derived });
  return derived;
}

function mac(dataDir: string, payload: string): Buffer {
  return createHmac("sha256", subkey(dataDir)).update(payload).digest();
}

/** Mint a passport for `aud` carrying `scopes`, valid for `ttlMs` from `now`. */
export function issue(
  dataDir: string,
  input: {
    iss: string;
    aud: string;
    scopes: readonly string[];
    ttlMs: number;
    now: number;
  },
): Result<string, IssueError> {
  if (!NAME.test(input.iss) || !NAME.test(input.aud)) return err("bad_name");
  const scopes = [...new Set(input.scopes)].sort();
  if (
    scopes.length === 0 ||
    scopes.length > MAX_SCOPES ||
    !scopes.every((s) => NAME.test(s))
  )
    return err("bad_scopes");
  if (
    !Number.isFinite(input.ttlMs) ||
    input.ttlMs <= 0 ||
    input.ttlMs > MAX_TTL_MS
  )
    return err("bad_ttl");
  const body: Passport = {
    iss: input.iss,
    aud: input.aud,
    scopes,
    exp: Math.floor(input.now + input.ttlMs),
  };
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  return ok(`${PREFIX}.${payload}.${mac(dataDir, payload).toString("base64url")}`);
}

/**
 * Accept a passport only if it is genuine, unexpired, addressed to
 * `audience`, and carries `scope`. Every refusal is a value, none reveals
 * why the signature failed.
 */
export function verify(
  dataDir: string,
  token: string,
  want: { audience: string; scope: string; now: number },
): Result<Passport, VerifyError> {
  if (typeof token !== "string" || token.length > MAX_LEN)
    return err("bad_format");
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return err("bad_format");
  const [, payload, sig] = parts as [string, string, string];
  // One valid encoding only: base64url decoding is lenient (padding, stray
  // characters, spare low bits), so compare the canonical text, not the bytes.
  const given = Buffer.from(sig);
  const expected = Buffer.from(mac(dataDir, payload).toString("base64url"));
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return err("bad_signature");

  let body: Passport;
  try {
    body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return err("bad_format");
  }
  if (
    typeof body?.iss !== "string" ||
    typeof body.aud !== "string" ||
    typeof body.exp !== "number" ||
    !Array.isArray(body.scopes) ||
    !NAME.test(body.iss) ||
    !NAME.test(body.aud) ||
    !body.scopes.every((s) => typeof s === "string")
  )
    return err("bad_format");
  if (want.now >= body.exp) return err("expired");
  if (body.aud !== want.audience) return err("wrong_audience");
  if (!body.scopes.includes(want.scope)) return err("missing_scope");
  return ok(body);
}
