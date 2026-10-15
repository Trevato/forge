/**
 * WebAuthn passkey verification with no dependency: registration and
 * assertion for ES256 and RS256. Plain data in (base64url strings as the
 * browser sends them), plain data out (a result or a named refusal). It
 * holds no state and has no route; `challenges()` is the one-time store a
 * caller keeps between issuing a challenge and verifying its answer.
 * Only `none` attestation is accepted : the key is trusted on first use.
 */

export type Jwk = { kty: "EC"; crv: "P-256"; x: string; y: string } | { kty: "RSA"; n: string; e: string };
export type Alg = "ES256" | "RS256";
export type Credential = { id: string; alg: Alg; key: Jwk; signCount: number };
export type Refusal = { ok: false; error: string };

const MAX_INPUT = 16 * 1024;
const COSE_ALG = { "-7": "ES256", "-257": "RS256" } as const;
const te = new TextEncoder();
const fail = (error: string): Refusal => ({ ok: false, error });

export function b64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

type Bytes = Uint8Array<ArrayBuffer>;

function unb64u(s: unknown): Bytes | null {
  if (typeof s !== "string" || s.length > MAX_INPUT || !/^[A-Za-z0-9_-]*$/.test(s)) return null;
  return new Uint8Array(Buffer.from(s, "base64url"));
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

/** A fresh random challenge, base64url. */
export function newChallenge(): string {
  return b64u(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * Outstanding challenges: each answers once, and only before it expires.
 * One global store: when it gets a route, rate-limit `issue()` per socket
 * address or key challenges by session, or a flood evicts real ones.
 */
export function challenges(ttlMs = 5 * 60_000, now: () => number = Date.now, max = 10_000) {
  const open = new Map<string, number>();
  return {
    issue(): string {
      for (const [c, at] of open) if (at <= now()) open.delete(c);
      if (open.size >= max) open.delete(open.keys().next().value!);
      const c = newChallenge();
      open.set(c, now() + ttlMs);
      return c;
    },
    /** True once per issued, unexpired challenge; a replay is false. */
    consume(challenge: unknown): boolean {
      if (typeof challenge !== "string") return false;
      const at = open.get(challenge);
      open.delete(challenge);
      return at !== undefined && at > now();
    },
  };
}

// --- CBOR (the subset WebAuthn uses) ---------------------------------------

type Cbor = number | Uint8Array | string | Cbor[] | Map<Cbor, Cbor> | boolean | null;

function cbor(b: Uint8Array, at = 0, depth = 0): [Cbor, number] {
  if (depth > 8 || at >= b.length) throw new Error("cbor");
  const major = b[at]! >> 5;
  const info = b[at]! & 31;
  let p = at + 1;
  let n = info;
  if (info === 24) n = b[p++]!;
  else if (info === 25) { n = (b[p]! << 8) | b[p + 1]!; p += 2; }
  else if (info === 26) { n = new DataView(b.buffer, b.byteOffset).getUint32(p); p += 4; }
  else if (info > 26) {
    if (major === 7 && info >= 20 && info <= 22) return [info === 20 ? false : info === 21 ? true : null, p];
    throw new Error("cbor");
  }
  if (p > b.length) throw new Error("cbor");
  switch (major) {
    case 0: return [n, p];
    case 1: return [-1 - n, p];
    case 2:
    case 3: {
      if (p + n > b.length) throw new Error("cbor");
      const s = b.subarray(p, p + n);
      return [major === 2 ? s : new TextDecoder("utf-8", { fatal: true }).decode(s), p + n];
    }
    case 4: {
      if (n > 64) throw new Error("cbor");
      const a: Cbor[] = [];
      for (let i = 0; i < n; i++) { const [v, q] = cbor(b, p, depth + 1); a.push(v); p = q; }
      return [a, p];
    }
    case 5: {
      if (n > 64) throw new Error("cbor");
      const m = new Map<Cbor, Cbor>();
      for (let i = 0; i < n; i++) {
        const [k, q] = cbor(b, p, depth + 1);
        const [v, r] = cbor(b, q, depth + 1);
        m.set(k, v);
        p = r;
      }
      return [m, p];
    }
    default: throw new Error("cbor");
  }
}

// --- shared checks ----------------------------------------------------------

/** User verification (PIN or biometric) is required unless the caller says "preferred". */
type Expect = { challenge: string; origin: string; rpId: string; userVerification?: "required" | "preferred" };

function flagsRefusal(flags: number, want: Expect): Refusal | null {
  if (!(flags & 0x01)) return fail("user presence missing");
  if (want.userVerification !== "preferred" && !(flags & 0x04)) return fail("user verification missing");
  return null;
}

function clientData(raw: unknown, type: string, want: Expect): Refusal | null {
  const bytes = unb64u(raw);
  if (!bytes) return fail("clientDataJSON is not base64url");
  let cd: any;
  try { cd = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return fail("clientDataJSON is not JSON"); }
  if (!cd || typeof cd !== "object") return fail("clientDataJSON is not JSON");
  if (cd.type !== type) return fail("wrong ceremony type");
  if (typeof cd.challenge !== "string" || !equal(te.encode(cd.challenge), te.encode(want.challenge))) return fail("challenge does not match");
  if (cd.origin !== want.origin) return fail("origin does not match");
  if (cd.crossOrigin === true) return fail("cross-origin ceremony refused");
  return null;
}

async function rpIdHashOk(authData: Uint8Array, rpId: string): Promise<boolean> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(rpId)));
  return equal(authData.subarray(0, 32), h);
}

const u32 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset).getUint32(at);

// --- registration -----------------------------------------------------------

export type Registration = {
  clientDataJSON: string;
  attestationObject: string;
};

/** Verify a `navigator.credentials.create` answer; return the credential to store. */
export async function verifyRegistration(
  response: Registration,
  want: Expect,
): Promise<({ ok: true; uv: boolean } & Credential) | Refusal> {
  try {
    const bad = clientData(response?.clientDataJSON, "webauthn.create", want);
    if (bad) return bad;
    const att = unb64u(response.attestationObject);
    if (!att) return fail("attestationObject is not base64url");
    const [obj] = cbor(att);
    if (!(obj instanceof Map)) return fail("attestationObject is malformed");
    if (obj.get("fmt") !== "none") return fail("only none attestation is accepted");
    const ad = obj.get("authData");
    if (!(ad instanceof Uint8Array) || ad.length < 55) return fail("authData is malformed");
    if (!(await rpIdHashOk(ad, want.rpId))) return fail("rpId does not match");
    const flags = ad[32]!;
    const flagBad = flagsRefusal(flags, want);
    if (flagBad) return flagBad;
    if (!(flags & 0x40)) return fail("no credential in authData");
    const idLen = (ad[53]! << 8) | ad[54]!;
    if (idLen < 1 || idLen > 1023 || 55 + idLen >= ad.length) return fail("authData is malformed");
    const id = ad.subarray(55, 55 + idLen);
    const [cose] = cbor(ad, 55 + idLen);
    if (!(cose instanceof Map)) return fail("public key is malformed");
    const alg = COSE_ALG[String(cose.get(3)) as keyof typeof COSE_ALG];
    if (!alg) return fail("unsupported algorithm");
    let key: Jwk;
    if (alg === "ES256") {
      const x = cose.get(-2), y = cose.get(-3);
      if (cose.get(1) !== 2 || cose.get(-1) !== 1 || !(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32)
        return fail("public key is malformed");
      key = { kty: "EC", crv: "P-256", x: b64u(x), y: b64u(y) };
    } else {
      const n = cose.get(-1), e = cose.get(-2);
      if (cose.get(1) !== 3 || !(n instanceof Uint8Array) || !(e instanceof Uint8Array) || n.length < 256 || n.length > 1024 || e.length < 1 || e.length > 8)
        return fail("public key is malformed");
      key = { kty: "RSA", n: b64u(n), e: b64u(e) };
    }
    await importKey(alg, key); // refuse a key the platform cannot use
    return { ok: true, id: b64u(id), alg, key, signCount: u32(ad, 33), uv: !!(flags & 0x04) };
  } catch {
    return fail("registration is malformed");
  }
}

function importKey(alg: Alg, jwk: Jwk): Promise<CryptoKey> {
  const algo = alg === "ES256" ? { name: "ECDSA", namedCurve: "P-256" } : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  return crypto.subtle.importKey("jwk", jwk as any, algo, false, ["verify"]);
}

// --- assertion --------------------------------------------------------------

export type Assertion = {
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
};

/** ASN.1 DER ECDSA signature to the raw r||s WebCrypto verifies. */
export function derToRaw(der: Uint8Array): Bytes | null {
  let p = 0;
  const len = () => {
    let l = der[p++]!;
    if (l & 0x80) { const k = l & 0x7f; if (k < 1 || k > 2) return -1; l = 0; for (let i = 0; i < k; i++) l = (l << 8) | der[p++]!; }
    return l;
  };
  if (der[p++] !== 0x30) return null;
  if (len() !== der.length - p) return null;
  const out: Bytes = new Uint8Array(64);
  for (let half = 0; half < 2; half++) {
    if (der[p++] !== 0x02) return null;
    let l = len();
    if (l < 1 || p + l > der.length) return null;
    let int = der.subarray(p, p + l);
    p += l;
    while (int.length > 32 && int[0] === 0) int = int.subarray(1);
    if (int.length > 32) return null;
    out.set(int, half * 32 + 32 - int.length);
  }
  return p === der.length ? out : null;
}

/** Verify a `navigator.credentials.get` answer against the stored credential. */
export async function verifyAssertion(
  response: Assertion,
  want: Expect,
  stored: Credential,
): Promise<{ ok: true; signCount: number; uv: boolean } | Refusal> {
  try {
    const bad = clientData(response?.clientDataJSON, "webauthn.get", want);
    if (bad) return bad;
    const ad = unb64u(response.authenticatorData);
    const sig = unb64u(response.signature);
    const cdBytes = unb64u(response.clientDataJSON)!;
    if (!ad || ad.length < 37) return fail("authenticatorData is malformed");
    if (!sig || sig.length === 0) return fail("signature is malformed");
    if (!(await rpIdHashOk(ad, want.rpId))) return fail("rpId does not match");
    const flagBad = flagsRefusal(ad[32]!, want);
    if (flagBad) return flagBad;
    const signed: Bytes = new Uint8Array(ad.length + 32);
    signed.set(ad);
    signed.set(new Uint8Array(await crypto.subtle.digest("SHA-256", cdBytes)), ad.length);
    const key = await importKey(stored.alg, stored.key);
    let ok: boolean;
    if (stored.alg === "ES256") {
      const raw = derToRaw(sig);
      ok = !!raw && (await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, raw, signed));
    } else {
      ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, signed);
    }
    if (!ok) return fail("signature does not verify");
    const signCount = u32(ad, 33);
    if ((signCount !== 0 || stored.signCount !== 0) && signCount <= stored.signCount)
      return fail("signCount did not increase: the authenticator may be cloned");
    return { ok: true, signCount, uv: !!(ad[32]! & 0x04) };
  } catch {
    return fail("assertion is malformed");
  }
}
