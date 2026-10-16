/**
 * A software authenticator for tests: a P-256 key that answers the creation
 * and sign-in ceremonies the way a browser's would (attestation "none"), and
 * `passkeyFields`, which runs a page's options route and returns the hidden
 * fields `passkey-client.ts` fills before a form that makes an account posts.
 */
import { b64u } from "../../src/auth/webauthn.ts";

const te = new TextEncoder();
const sha = async (d: Uint8Array<ArrayBuffer>) => new Uint8Array(await crypto.subtle.digest("SHA-256", d));
const cat = (...p: Uint8Array[]): Uint8Array<ArrayBuffer> => { const o: Uint8Array<ArrayBuffer> = new Uint8Array(p.reduce((n, a) => n + a.length, 0)); let i = 0; for (const a of p) { o.set(a, i); i += a.length; } return o; };
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

export type Device = Awaited<ReturnType<typeof device>>;

/** An authenticator bound to one origin, e.g. `http://127.0.0.1:1234`. */
export async function device(origin: string, rp = new URL(origin).hostname) {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const unb = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
  const cose: [number, V][] = [[1, 2], [3, -7], [-1, 1], [-2, unb(jwk.x!)], [-3, unb(jwk.y!)]];
  const id = crypto.getRandomValues(new Uint8Array(32));
  let count = 0;
  const cd = (type: string, challenge: string) => te.encode(JSON.stringify({ type, challenge, origin }));
  const counter = (n: number) => Uint8Array.of(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  return {
    credId: b64u(id),
    async create(challenge: string) {
      const authData = cat(await sha(te.encode(rp)), Uint8Array.of(0x45), counter(0), new Uint8Array(16), Uint8Array.of(0, id.length), id, enc(cose as V));
      return { clientDataJSON: b64u(cd("webauthn.create", challenge)), attestationObject: b64u(enc([["fmt", "none"], ["attStmt", []], ["authData", authData]])) };
    },
    async get(challenge: string) {
      const clientData = cd("webauthn.get", challenge);
      const authData = cat(await sha(te.encode(rp)), Uint8Array.of(0x05), counter(++count));
      const sig = rawToDer(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, cat(authData, await sha(clientData)))));
      return { id: b64u(id), clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(sig) };
    },
  };
}

/**
 * What the page's button does: ask `base + optionsPath` for a challenge with
 * `who` (the form's token, username, email), make the key, and return the
 * hidden fields to post with the form. `headers` carries a session cookie
 * where the page needs one. Throws when the options route refuses.
 */
export async function passkeyFields(
  base: string,
  optionsPath: string,
  who: Record<string, string>,
  opts: { headers?: Record<string, string>; device?: Device } = {},
): Promise<{ challenge: string; clientDataJSON: string; attestationObject: string }> {
  const origin = new URL(base).origin;
  const res = await fetch(`${base}${optionsPath}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, ...opts.headers },
    body: JSON.stringify(who),
  });
  if (res.status !== 200) throw new Error(`passkey options ${res.status} ${await res.text()}`);
  const { challenge } = (await res.json()) as { challenge: string };
  const d = opts.device ?? (await device(origin));
  return { challenge, ...(await d.create(challenge)) };
}
