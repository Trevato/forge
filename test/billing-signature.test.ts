import { describe, expect, test } from "bun:test";
import { verifyStripeSignature } from "../src/billing/signature";

const secret = "whsec_test_secret";
const enc = new TextEncoder();
const NOW = 1_700_000_000;

async function sign(body: Uint8Array, t: number, key = secret): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const payload = new Uint8Array([...enc.encode(`${t}.`), ...body]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, payload));
  return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const body = enc.encode('{"id":"evt_1","type":"checkout.session.completed"}');

describe("verifyStripeSignature", () => {
  test("good signature is ok, other header keys ignored", async () => {
    const v1 = await sign(body, NOW);
    expect(await verifyStripeSignature(body, `t=${NOW},v1=${v1},v0=abc,foo=bar`, secret, NOW)).toBe("ok");
  });

  test("wrong secret, altered body, or altered hex is bad", async () => {
    const v1 = await sign(body, NOW, "whsec_other");
    expect(await verifyStripeSignature(body, `t=${NOW},v1=${v1}`, secret, NOW)).toBe("bad");
    const good = await sign(body, NOW);
    expect(await verifyStripeSignature(enc.encode("{}"), `t=${NOW},v1=${good}`, secret, NOW)).toBe("bad");
    expect(await verifyStripeSignature(body, `t=${NOW + 1},v1=${good}`, secret, NOW)).toBe("bad");
    expect(await verifyStripeSignature(body, `t=${NOW},v1=${"0".repeat(64)}`, secret, NOW)).toBe("bad");
  });

  test("stale beyond 300 s either way, ok at the edge", async () => {
    const old = NOW - 301;
    expect(await verifyStripeSignature(body, `t=${old},v1=${await sign(body, old)}`, secret, NOW)).toBe("stale");
    const future = NOW + 301;
    expect(await verifyStripeSignature(body, `t=${future},v1=${await sign(body, future)}`, secret, NOW)).toBe("stale");
    const edge = NOW - 300;
    expect(await verifyStripeSignature(body, `t=${edge},v1=${await sign(body, edge)}`, secret, NOW)).toBe("ok");
  });

  test("a stale but forged signature is bad, not stale", async () => {
    const old = NOW - 1000;
    expect(await verifyStripeSignature(body, `t=${old},v1=${"1".repeat(64)}`, secret, NOW)).toBe("bad");
  });

  test("two v1 values: either may match (rotation)", async () => {
    const old = await sign(body, NOW, "whsec_retired");
    const cur = await sign(body, NOW);
    expect(await verifyStripeSignature(body, `t=${NOW},v1=${old},v1=${cur}`, secret, NOW)).toBe("ok");
    expect(await verifyStripeSignature(body, `t=${NOW},v1=${cur},v1=${old}`, secret, NOW)).toBe("ok");
    expect(await verifyStripeSignature(body, `t=${NOW},v1=${old},v1=${old}`, secret, NOW)).toBe("bad");
  });

  test("malformed headers are bad", async () => {
    const v1 = await sign(body, NOW);
    for (const h of ["", "garbage", `v1=${v1}`, `t=${NOW}`, `t=abc,v1=${v1}`, `t=${NOW},v1=zz`, `t=${NOW},v1=${v1.slice(2)}`, `t=-5,v1=${v1}`]) {
      expect(await verifyStripeSignature(body, h, secret, NOW)).toBe("bad");
    }
    expect(await verifyStripeSignature(body, `t=${NOW},v1=${v1}`, "", NOW)).toBe("bad");
  });

  test("signs the raw bytes, not the re-serialized JSON", async () => {
    const raw = enc.encode('{ "a": 1,  "b":[1, 2] }');
    const reserialized = enc.encode(JSON.stringify(JSON.parse(new TextDecoder().decode(raw))));
    expect(reserialized).not.toEqual(raw);
    const v1 = await sign(raw, NOW);
    expect(await verifyStripeSignature(raw, `t=${NOW},v1=${v1}`, secret, NOW)).toBe("ok");
    expect(await verifyStripeSignature(reserialized, `t=${NOW},v1=${v1}`, secret, NOW)).toBe("bad");
  });

  test("non-UTF-8 bytes are signed as bytes", async () => {
    const raw = new Uint8Array([0xff, 0xfe, 0x00, 0x7b]);
    expect(await verifyStripeSignature(raw, `t=${NOW},v1=${await sign(raw, NOW)}`, secret, NOW)).toBe("ok");
  });
});
