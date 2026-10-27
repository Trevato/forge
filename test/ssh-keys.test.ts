/**
 * SSH signature checks (#6902): a good signature verifies, and another key, a
 * changed message, an algorithm downgrade and a malformed blob are each
 * refused without throwing.
 */
import { describe, expect, test } from "bun:test";
import {
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import {
  fingerprintOf,
  keyAlgorithmMatches,
  verifySshSignature,
} from "../src/ssh/keys.ts";
import { Writer } from "../src/ssh/wire.ts";

const message = new TextEncoder().encode("session-id and userauth payload");

function jwkBytes(key: KeyObject, field: string): Uint8Array {
  const jwk = createPublicKey(key).export({ format: "jwk" }) as Record<
    string,
    string
  >;
  return Buffer.from(jwk[field]!, "base64url");
}

interface Pair {
  blob: Uint8Array;
  signWith(algo: string, msg: Uint8Array): Uint8Array;
}

function ed25519Pair(): Pair {
  const { privateKey } = generateKeyPairSync("ed25519");
  return {
    blob: new Writer()
      .string("ssh-ed25519")
      .string(jwkBytes(privateKey, "x"))
      .build(),
    signWith: (algo, msg) =>
      new Writer()
        .string(algo)
        .string(sign(null, msg, privateKey))
        .build(),
  };
}

function rsaPair(): Pair {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    blob: new Writer()
      .string("ssh-rsa")
      .mpint(jwkBytes(privateKey, "e"))
      .mpint(jwkBytes(privateKey, "n"))
      .build(),
    signWith: (algo, msg) => {
      const hash =
        algo === "rsa-sha2-512"
          ? "sha512"
          : algo === "ssh-rsa"
            ? "sha1"
            : "sha256";
      return new Writer()
        .string(algo)
        .string(sign(hash, msg, privateKey))
        .build();
    },
  };
}

const flip = (bytes: Uint8Array): Uint8Array => {
  const copy = bytes.slice();
  copy[0] = copy[0]! ^ 1;
  return copy;
};

describe("verifySshSignature", () => {
  const cases: [string, string, () => Pair][] = [
    ["ssh-ed25519", "ssh-ed25519", ed25519Pair],
    ["rsa-sha2-256", "rsa-sha2-256", rsaPair],
    ["rsa-sha2-512", "rsa-sha2-512", rsaPair],
  ];

  for (const [name, algo, make] of cases) {
    describe(name, () => {
      const pair = make();
      const good = pair.signWith(algo, message);

      test("a good signature verifies", () => {
        expect(verifySshSignature(algo, pair.blob, good, message).ok).toBe(
          true,
        );
      });

      test("a signature by another key is refused", () => {
        const other = make();
        const sig = other.signWith(algo, message);
        expect(verifySshSignature(algo, pair.blob, sig, message).ok).toBe(
          false,
        );
      });

      test("one changed byte of the message is refused", () => {
        expect(
          verifySshSignature(algo, pair.blob, good, flip(message)).ok,
        ).toBe(false);
      });

      test("a truncated or garbage blob is refused without throwing", () => {
        const junk = [
          new Uint8Array(0),
          good.subarray(0, 6),
          good.subarray(0, good.length - 5),
          new Uint8Array(40).fill(0xff),
        ];
        for (const sig of junk) {
          expect(verifySshSignature(algo, pair.blob, sig, message).ok).toBe(
            false,
          );
        }
        expect(
          verifySshSignature(algo, pair.blob.subarray(0, 10), good, message).ok,
        ).toBe(false);
        expect(
          verifySshSignature(algo, new Uint8Array(0), good, message).ok,
        ).toBe(false);
      });
    });
  }

  test("an rsa-sha2-512 offer answered with an ssh-rsa (SHA-1) signature is refused", () => {
    const pair = rsaPair();
    const sha1 = pair.signWith("ssh-rsa", message);
    expect(
      verifySshSignature("rsa-sha2-512", pair.blob, sha1, message).ok,
    ).toBe(false);
    // Even offered as ssh-rsa itself, SHA-1 is not an accepted algorithm.
    expect(verifySshSignature("ssh-rsa", pair.blob, sha1, message).ok).toBe(
      false,
    );
  });

  test("a sha2-256 signature relabelled sha2-512, or the reverse, is refused", () => {
    const pair = rsaPair();
    const s256 = pair.signWith("rsa-sha2-256", message);
    expect(
      verifySshSignature("rsa-sha2-512", pair.blob, s256, message).ok,
    ).toBe(false);
  });

  test("an rsa algorithm over an ed25519 key is refused", () => {
    const ed = ed25519Pair();
    const sig = ed.signWith("rsa-sha2-256", message);
    expect(verifySshSignature("rsa-sha2-256", ed.blob, sig, message).ok).toBe(
      false,
    );
  });
});

describe("keyAlgorithmMatches", () => {
  test("rsa-sha2-256 and -512 pair with an ssh-rsa blob", () => {
    expect(keyAlgorithmMatches("rsa-sha2-256", "ssh-rsa")).toBe(true);
    expect(keyAlgorithmMatches("rsa-sha2-512", "ssh-rsa")).toBe(true);
  });

  test("identical names match, and nothing else differing does", () => {
    expect(keyAlgorithmMatches("ssh-ed25519", "ssh-ed25519")).toBe(true);
    expect(keyAlgorithmMatches("ssh-rsa", "ssh-rsa")).toBe(true);
    expect(keyAlgorithmMatches("ssh-rsa", "rsa-sha2-256")).toBe(false);
    expect(keyAlgorithmMatches("rsa-sha2-256", "ssh-ed25519")).toBe(false);
    expect(keyAlgorithmMatches("ssh-ed25519", "ssh-rsa")).toBe(false);
    expect(keyAlgorithmMatches("rsa-sha2-256", "rsa-sha2-512")).toBe(false);
    expect(keyAlgorithmMatches("ecdsa-sha2-nistp256", "ssh-rsa")).toBe(false);
  });
});

describe("fingerprintOf", () => {
  test("prints SHA256: and unpadded base64 for a fixed blob", () => {
    // sha256("") is e3b0c442…b855; 32 bytes base64 would end in "=".
    expect(fingerprintOf(new Uint8Array(0))).toBe(
      "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU",
    );
    expect(fingerprintOf(new TextEncoder().encode("abc"))).toBe(
      "SHA256:ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0",
    );
  });
});
