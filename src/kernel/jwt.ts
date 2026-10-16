/**
 * Verifying a JWT someone else signed: ES256 only, the key looked up by
 * `kid` through a function the caller gives (so where keys come from — a
 * cache, a fetch, a test — is not this file's business), then the claims a
 * relying party must check: issuer, audience, expiry and, when asked, nonce.
 * Anything off is `invalid_token`; the reason is not told to the caller.
 */
import { err, ok, type Result } from "./result.ts";

export type Jwk = Record<string, unknown>;

export interface JwtExpect {
  readonly issuer: string;
  readonly audience: string;
  readonly nonce?: string;
}

const KEY = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;
const SEGMENT = /^[A-Za-z0-9_-]+$/;

const decode = (part: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(Buffer.from(part, "base64url").toString());
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("not an object");
  return parsed as Record<string, unknown>;
};

export async function verifyJwt(
  jwt: string,
  keyFor: (kid: string) => Promise<Jwk | undefined>,
  expect: JwtExpect,
  now = Date.now(),
): Promise<Result<Record<string, unknown>, "invalid_token">> {
  const parts = jwt.split(".");
  if (parts.length !== 3 || !parts.every((p) => SEGMENT.test(p)))
    return err("invalid_token");
  try {
    const head = decode(parts[0]!);
    if (head["alg"] !== "ES256" || typeof head["kid"] !== "string")
      return err("invalid_token");
    const jwk = await keyFor(head["kid"]);
    if (jwk === undefined) return err("invalid_token");
    const pub = await crypto.subtle.importKey("jwk", jwk as never, KEY, false, ["verify"]);
    const good = await crypto.subtle.verify(
      SIGN,
      pub,
      Buffer.from(parts[2]!, "base64url"),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    if (!good) return err("invalid_token");
    const claims = decode(parts[1]!);
    if (claims["iss"] !== expect.issuer || claims["aud"] !== expect.audience)
      return err("invalid_token");
    if (typeof claims["exp"] !== "number" || claims["exp"] * 1000 <= now)
      return err("invalid_token");
    if (expect.nonce !== undefined && claims["nonce"] !== expect.nonce)
      return err("invalid_token");
    return ok(claims);
  } catch {
    return err("invalid_token");
  }
}
