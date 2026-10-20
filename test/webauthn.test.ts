/**
 * Passkey verification, against a software authenticator that makes real
 * keys and signs like a browser's: registration and assertion for ES256 and
 * RS256, and the refusals (wrong origin, replayed challenge, signCount
 * going backwards, wrong rpId, bad signature, attestation other than none).
 */
import { describe, expect, test } from "bun:test";
import { b64u, challenges, derToRaw, verifyAssertion, verifyRegistration, type Alg, type Credential } from "../src/auth/webauthn.ts";

const ORIGIN = "https://forge.example";
const RP = "forge.example";
const te = new TextEncoder();
const sha = async (d: Uint8Array<ArrayBuffer>) => new Uint8Array(await crypto.subtle.digest("SHA-256", d));
const cat = (...p: Uint8Array[]): Uint8Array<ArrayBuffer> => { const o: Uint8Array<ArrayBuffer> = new Uint8Array(p.reduce((n, a) => n + a.length, 0)); let i = 0; for (const a of p) { o.set(a, i); i += a.length; } return o; };

// A minimal CBOR encoder, enough for an attestation object.
function head(major: number, n: number): Uint8Array {
  if (n < 24) return Uint8Array.of((major << 5) | n);
  if (n < 256) return Uint8Array.of((major << 5) | 24, n);
  return Uint8Array.of((major << 5) | 25, n >> 8, n & 255);
}
type V = number | string | Uint8Array | [V, V][];
function enc(v: V): Uint8Array {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") { const b = te.encode(v); return cat(head(3, b.length), b); }
  if (v instanceof Uint8Array) return cat(head(2, v.length), v);
  return cat(head(5, v.length), ...v.flatMap(([k, x]) => [enc(k), enc(x)]));
}

function rawToDer(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  const int = (b: Uint8Array) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.subarray(i); if (b[0]! & 0x80) b = cat(Uint8Array.of(0), b); return cat(Uint8Array.of(2, b.length), b); };
  const body = cat(int(raw.subarray(0, 32)), int(raw.subarray(32)));
  return cat(Uint8Array.of(0x30, body.length), body);
}

async function authenticator(alg: Alg) {
  const pair = (await (alg === "ES256"
    ? crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])
    : crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-256" }, true, ["sign"]))) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const unb = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
  const cose: [number, V][] = alg === "ES256"
    ? [[1, 2], [3, -7], [-1, 1], [-2, unb(jwk.x!)], [-3, unb(jwk.y!)]]
    : [[1, 3], [3, -257], [-1, unb(jwk.n!)], [-2, unb(jwk.e!)]];
  const id = crypto.getRandomValues(new Uint8Array(32));
  const cd = (type: string, challenge: string, origin = ORIGIN, extra: object = {}) => te.encode(JSON.stringify({ type, challenge, origin, ...extra }));
  const counter = (n: number) => Uint8Array.of(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  return {
    id,
    async create(challenge: string, o: { origin?: string; rp?: string; fmt?: string; type?: string; flags?: number; extra?: object } = {}) {
      const authData = cat(await sha(te.encode(o.rp ?? RP)), Uint8Array.of(o.flags ?? 0x45), counter(0), new Uint8Array(16), Uint8Array.of(0, id.length), id, enc(cose as V));
      return {
        clientDataJSON: b64u(cd(o.type ?? "webauthn.create", challenge, o.origin, o.extra)),
        attestationObject: b64u(enc([["fmt", o.fmt ?? "none"], ["attStmt", []], ["authData", authData]])),
      };
    },
    async get(challenge: string, signCount: number, o: { origin?: string; rp?: string; flags?: number; type?: string; extra?: object } = {}) {
      const clientData = cd(o.type ?? "webauthn.get", challenge, o.origin, o.extra);
      const authData = cat(await sha(te.encode(o.rp ?? RP)), Uint8Array.of(o.flags ?? 0x05), counter(signCount));
      const signed = cat(authData, await sha(clientData));
      let sig: Uint8Array<ArrayBuffer> = new Uint8Array(await crypto.subtle.sign(alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : "RSASSA-PKCS1-v1_5", pair.privateKey, signed));
      if (alg === "ES256") sig = rawToDer(sig);
      return { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(sig) };
    },
  };
}

const want = (challenge: string) => ({ challenge, origin: ORIGIN, rpId: RP });

for (const alg of ["ES256", "RS256"] as const) {
  describe(alg, () => {
    test("registers, then asserts with a rising signCount", async () => {
      const a = await authenticator(alg);
      const reg = await verifyRegistration(await a.create("c1"), want("c1"));
      if (!reg.ok) throw new Error(reg.error);
      expect(reg.alg).toBe(alg);
      expect(reg.id).toBe(b64u(a.id));
      expect(reg.signCount).toBe(0);
      const stored: Credential = { id: reg.id, alg: reg.alg, key: reg.key, signCount: reg.signCount };
      const one = await verifyAssertion(await a.get("c2", 1), want("c2"), stored);
      expect(one).toEqual({ ok: true, signCount: 1, uv: true });
      stored.signCount = 5;
      const back = await verifyAssertion(await a.get("c3", 5), want("c3"), stored);
      expect(back).toEqual({ ok: false, error: expect.stringContaining("signCount") });
      const lower = await verifyAssertion(await a.get("c3", 2), want("c3"), stored);
      expect(lower.ok).toBe(false);
      expect((await verifyAssertion(await a.get("c3", 6), want("c3"), stored)).ok).toBe(true);
    });

    test("refuses a wrong origin, rpId and challenge", async () => {
      const a = await authenticator(alg);
      expect(await verifyRegistration(await a.create("c", { origin: "https://evil.example" }), want("c"))).toEqual({ ok: false, error: "origin does not match" });
      expect(await verifyRegistration(await a.create("c", { rp: "evil.example" }), want("c"))).toEqual({ ok: false, error: "rpId does not match" });
      expect(await verifyRegistration(await a.create("c"), want("other"))).toEqual({ ok: false, error: "challenge does not match" });
      const reg = await verifyRegistration(await a.create("c"), want("c"));
      if (!reg.ok) throw new Error(reg.error);
      const stored: Credential = { id: reg.id, alg, key: reg.key, signCount: 0 };
      expect(await verifyAssertion(await a.get("c", 1, { origin: "https://evil.example" }), want("c"), stored)).toEqual({ ok: false, error: "origin does not match" });
      expect(await verifyAssertion(await a.get("c", 1, { rp: "evil.example" }), want("c"), stored)).toEqual({ ok: false, error: "rpId does not match" });
    });

    test("refuses a signature from another key or a tampered one", async () => {
      const a = await authenticator(alg);
      const b = await authenticator(alg);
      const reg = await verifyRegistration(await a.create("c"), want("c"));
      if (!reg.ok) throw new Error(reg.error);
      const stored: Credential = { id: reg.id, alg, key: reg.key, signCount: 0 };
      expect((await verifyAssertion(await b.get("c", 1), want("c"), stored)).ok).toBe(false);
      const good = await a.get("c", 1);
      const sig = Buffer.from(good.signature, "base64url");
      sig[sig.length - 1]! ^= 1;
      expect((await verifyAssertion({ ...good, signature: sig.toString("base64url") }, want("c"), stored)).ok).toBe(false);
    });
  });
}

test("a first assertion with signCount 0 is fine when the authenticator keeps no counter", async () => {
  const a = await authenticator("ES256");
  const reg = await verifyRegistration(await a.create("c"), want("c"));
  if (!reg.ok) throw new Error(reg.error);
  const stored: Credential = { id: reg.id, alg: "ES256", key: reg.key, signCount: 0 };
  expect((await verifyAssertion(await a.get("c", 0), want("c"), stored)).ok).toBe(true);
});

test("user presence and user verification are required, in both ceremonies", async () => {
  const a = await authenticator("ES256");
  expect(await verifyRegistration(await a.create("c", { flags: 0x44 }), want("c"))).toEqual({ ok: false, error: "user presence missing" });
  expect(await verifyRegistration(await a.create("c", { flags: 0x41 }), want("c"))).toEqual({ ok: false, error: "user verification missing" });
  const soft = await verifyRegistration(await a.create("c", { flags: 0x41 }), { ...want("c"), userVerification: "preferred" });
  if (!soft.ok) throw new Error(soft.error);
  expect(soft.uv).toBe(false);
  const reg = await verifyRegistration(await a.create("c"), want("c"));
  if (!reg.ok) throw new Error(reg.error);
  expect(reg.uv).toBe(true);
  const stored: Credential = { id: reg.id, alg: "ES256", key: reg.key, signCount: 0 };
  expect(await verifyAssertion(await a.get("c", 1, { flags: 0x04 }), want("c"), stored)).toEqual({ ok: false, error: "user presence missing" });
  expect(await verifyAssertion(await a.get("c", 1, { flags: 0x01 }), want("c"), stored)).toEqual({ ok: false, error: "user verification missing" });
  expect(await verifyAssertion(await a.get("c", 1, { flags: 0x01 }), { ...want("c"), userVerification: "preferred" }, stored)).toEqual({ ok: true, signCount: 1, uv: false });
});

test("the ceremony type and cross-origin are checked", async () => {
  const a = await authenticator("ES256");
  const reg = await verifyRegistration(await a.create("c"), want("c"));
  if (!reg.ok) throw new Error(reg.error);
  const stored: Credential = { id: reg.id, alg: "ES256", key: reg.key, signCount: 0 };
  expect(await verifyAssertion(await a.get("c", 1, { type: "webauthn.create" }), want("c"), stored)).toEqual({ ok: false, error: "wrong ceremony type" });
  expect(await verifyRegistration(await a.create("c", { type: "webauthn.get" }), want("c"))).toEqual({ ok: false, error: "wrong ceremony type" });
  expect(await verifyAssertion(await a.get("c", 1, { extra: { crossOrigin: true } }), want("c"), stored)).toEqual({ ok: false, error: "cross-origin ceremony refused" });
  expect(await verifyRegistration(await a.create("c", { extra: { crossOrigin: true } }), want("c"))).toEqual({ ok: false, error: "cross-origin ceremony refused" });
});

test("garbage given to verifyAssertion is refused, never thrown", async () => {
  const a = await authenticator("ES256");
  const reg = await verifyRegistration(await a.create("c"), want("c"));
  if (!reg.ok) throw new Error(reg.error);
  const stored: Credential = { id: reg.id, alg: "ES256", key: reg.key, signCount: 0 };
  const good = await a.get("c", 1);
  for (const bad of [undefined, null, {}, { ...good, clientDataJSON: "!!" }, { ...good, authenticatorData: "AA" }, { ...good, signature: "" }, { ...good, signature: "AAAA" }, { ...good, signature: 7 }])
    expect((await verifyAssertion(bad as any, want("c"), stored)).ok).toBe(false);
});

test("attestation other than none is refused", async () => {
  const a = await authenticator("ES256");
  expect(await verifyRegistration(await a.create("c", { fmt: "packed" }), want("c"))).toEqual({ ok: false, error: "only none attestation is accepted" });
});

test("garbage is refused, never thrown", async () => {
  for (const bad of [undefined, null, {}, { clientDataJSON: "!!", attestationObject: "x" }, { clientDataJSON: b64u(te.encode("{}")), attestationObject: "AA" }])
    expect((await verifyRegistration(bad as any, want("c"))).ok).toBe(false);
  expect(derToRaw(Uint8Array.of(1, 2, 3))).toBeNull();
});

describe("challenges", () => {
  test("a challenge answers once: a replay is refused", () => {
    const c = challenges();
    const owner = "o";
    const x = c.issue(owner);
    expect(c.consume(x)).toBe(true);
    expect(c.consume(x)).toBe(false);
    expect(c.consume("never-issued")).toBe(false);
    expect(c.consume(undefined)).toBe(false);
  });
  test("a challenge expires", () => {
    let t = 0;
    const c = challenges(1000, () => t);
    const owner = "o";
    const x = c.issue(owner);
    t = 1000;
    expect(c.consume(x)).toBe(false);
  });
});
