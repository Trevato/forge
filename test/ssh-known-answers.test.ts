/**
 * Known answers for the key exchange. The X25519 vectors and the mpint
 * examples are the RFCs'; the exchange hash and the derived keys use K and Q
 * from RFC 7748 §6.1 and were computed once by an independent implementation
 * (Python's hashlib, written from RFC 4253 §7.2 and §8), not by this code.
 */

import { expect, test } from "bun:test";
import { createPublicKey, createPrivateKey, diffieHellman } from "node:crypto";
import { deriveKey, exchangeHashOf } from "../src/ssh/kex.ts";
import { fingerprintOf } from "../src/ssh/keys.ts";
import { sshString, Writer } from "../src/ssh/wire.ts";

const hex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, "hex"));
const toHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

const K = hex("4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742");
const Q_C = hex("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a");
const Q_S = hex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f");

test("X25519 as the transport calls it matches RFC 7748 §6.1", () => {
  const pkcs8 = Buffer.concat([hex("302e020100300506032b656e04220420"), hex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")]);
  const spki = Buffer.concat([hex("302a300506032b656e032100"), Buffer.from(Q_S)]);
  const shared = diffieHellman({
    privateKey: createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" }),
    publicKey: createPublicKey({ key: spki, format: "der", type: "spki" }),
  });
  expect(toHex(shared)).toBe(toHex(K));
});

test("mpint encoding matches RFC 4251 §5", () => {
  expect(toHex(new Writer(16).mpint(hex("")).build())).toBe("00000000");
  expect(toHex(new Writer(16).mpint(hex("09a378f9b2e332a7")).build())).toBe("0000000809a378f9b2e332a7");
  expect(toHex(new Writer(16).mpint(hex("80")).build())).toBe("000000020080");
});

const exchange = {
  clientVersion: new TextEncoder().encode("SSH-2.0-client"),
  serverVersion: new TextEncoder().encode("SSH-2.0-forge"),
  peerKexInit: Uint8Array.from([20, ...Array.from({ length: 16 }, (_, i) => i), ...new TextEncoder().encode("client-kexinit")]),
  myKexInit: Uint8Array.from([20, ...Array.from({ length: 16 }, (_, i) => 16 + i), ...new TextEncoder().encode("server-kexinit")]),
  hostBlob: Uint8Array.from([0, 0, 0, 11, ...new TextEncoder().encode("ssh-ed25519"), 0, 0, 0, 32, ...Array.from({ length: 32 }, (_, i) => i)]),
  clientPublic: Q_C,
  serverPublic: Q_S,
  kMpint: new Writer(48).mpint(K).build(),
};

const H = "b11eb4d9bab11f1f948a6f9d82e30e72bea4604453677185aeabfa8175c2d8f0";

test("the exchange hash is the known answer", () => {
  expect(toHex(exchangeHashOf(exchange))).toBe(H);
});

test("every field of the exchange hash matters", () => {
  for (const field of Object.keys(exchange) as (keyof typeof exchange)[]) {
    const bent = Uint8Array.from(exchange[field]);
    bent[bent.length - 1]! ^= 1;
    expect(toHex(exchangeHashOf({ ...exchange, [field]: bent }))).not.toBe(H);
  }
});

test("the six derived keys are the known answers (letters A to D, and the extension past one block)", () => {
  const id = hex(H);
  const k = (letter: string, n = 32) => toHex(deriveKey(exchange.kMpint, id, letter, id, n));
  expect(k("A")).toBe("6fb4665da6001b59586965d7b61cd1188dfb299a8c23565828b9dbbe1866568e");
  expect(k("B")).toBe("d72b996cb8e7b20b6e103876af82630807731987ac46a92aab896c660694477e");
  expect(k("C")).toBe("a7d5c78f1d612295d3f419effce7a9ec2258ce9cbb4e3b61e4ed0239de5f653a");
  expect(k("D")).toBe("0fc85b061fc62d5bae8358001c597713f3478be33c5d4b1f0560a20812eafe99");
  expect(k("C", 80)).toBe(
    "a7d5c78f1d612295d3f419effce7a9ec2258ce9cbb4e3b61e4ed0239de5f653a20ab4e55478c767dc9dcfc7e031e044306cbcdadb71b18b5c69c49d0e0fa94960848b73ea53d00ac54f490937767c5f2",
  );
  // The shorter key is a prefix of the longer one (RFC 4253 §7.2).
  expect(k("C", 16)).toBe(k("C").slice(0, 32));
});

test("a fingerprint is SHA256: and unpadded base64 of the blob", () => {
  const blob = sshString("ssh-ed25519");
  expect(fingerprintOf(blob)).toBe("SHA256:" + new Bun.CryptoHasher("sha256").update(blob).digest("base64").replace(/=+$/, ""));
});
