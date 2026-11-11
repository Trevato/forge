/**
 * A Stripe webhook signature, checked (#11243): one pure function, no I/O.
 * Header `t=<unix>,v1=<hex>[,v1=<hex>…]`; the signed payload is `${t}.${rawBody}`,
 * HMAC-SHA256 keyed by the `whsec_…` secret's UTF-8 bytes. Any `v1` may match
 * (a rotated secret signs twice); other keys are ignored.
 */
export type SignatureVerdict = "ok" | "bad" | "stale";

/** Seconds either side of `now` a timestamp may sit. */
export const TOLERANCE_SECONDS = 300;

const HEX = /^[0-9a-f]{64}$/i;

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Equal-length byte compare that does not stop at the first difference. */
function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function parse(header: string): { t: number; v1: string[] } | null {
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      if (!/^\d{1,12}$/.test(value)) return null;
      if (t === null) t = Number(value);
    } else if (key === "v1" && HEX.test(value)) v1.push(value);
  }
  return t === null || v1.length === 0 ? null : { t, v1 };
}

/** `now` is unix seconds. Malformed input is `bad`; a good signature too old or new is `stale`. */
export async function verifyStripeSignature(
  rawBody: Uint8Array,
  header: string,
  secret: string,
  now: number,
): Promise<SignatureVerdict> {
  if (typeof header !== "string" || typeof secret !== "string" || secret === "") return "bad";
  const parsed = parse(header);
  if (!parsed) return "bad";
  const prefix = new TextEncoder().encode(`${parsed.t}.`);
  const payload = new Uint8Array(prefix.length + rawBody.length);
  payload.set(prefix, 0);
  payload.set(rawBody, prefix.length);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, payload));
  let match = false;
  for (const candidate of parsed.v1) if (same(expected, fromHex(candidate))) match = true;
  if (!match) return "bad";
  return Math.abs(now - parsed.t) > TOLERANCE_SECONDS ? "stale" : "ok";
}
