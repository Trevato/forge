/**
 * Key rotation: a v2 value names the key that sealed it (first 8 hex of
 * SHA-256(key)), so `secret.key` can be replaced while the old key is kept as
 * `secret.key.old`, and every value sealed before still opens.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  forgetKey,
  keyId,
  loadKey,
  loadKeys,
  open,
  previousKeyPath,
  seal,
  secretKeyPath,
} from "../src/kernel/secret.ts";

/** A v1 value exactly as the old `seal` wrote it: `v1:<iv>:<ct+tag>`. */
function sealV1(key: Buffer, plain: string, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  c.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([c.update(plain, "utf8"), c.final(), c.getAuthTag()]);
  return `v1:${iv.toString("base64url")}:${body.toString("base64url")}`;
}

/** The operator's rotation: keep the current key as old, mint a new one. */
function rotate(dir: string): void {
  renameSync(secretKeyPath(dir), previousKeyPath(dir));
  forgetKey(dir);
}

describe("secret key rotation", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "forge-secret-rotation-"));
  });
  afterEach(() => {
    forgetKey(dir);
    rmSync(dir, { recursive: true, force: true });
  });

  test("seal writes v2:<keyid>:<iv>:<ct>, keyid the first 8 hex of SHA-256(key)", () => {
    const key = loadKey(dir);
    const sealed = seal(dir, "tok-1", "row-1");
    const parts = sealed.split(":");
    expect(parts.length).toBe(4);
    expect(parts[0]).toBe("v2");
    // Hand calculation: hash the key bytes and take 8 hex characters.
    expect(parts[1]).toBe(createHash("sha256").update(key).digest("hex").slice(0, 8));
    expect(keyId(key)).toBe(parts[1]!);
    expect(sealed).not.toContain("tok-1");
  });

  test("a value sealed under A opens after B is current with A kept old, and is bad_key once A is gone", () => {
    const a = loadKey(dir);
    const sealed = seal(dir, "tok-A", "row-1");
    rotate(dir);
    const ring = loadKeys(dir);
    expect(ring.previous?.id).toBe(keyId(a));
    expect(ring.current.id).not.toBe(keyId(a));
    const opened = open(dir, sealed, "row-1");
    expect(opened.ok && opened.value).toBe("tok-A");
    // New values go under B.
    expect(seal(dir, "tok-B", "row-2").split(":")[1]).toBe(ring.current.id);
    // The AAD still binds under the previous key.
    expect(open(dir, sealed, "row-2")).toMatchObject({ ok: false, error: "bad_key" });

    rmSync(previousKeyPath(dir));
    forgetKey(dir);
    const gone = open(dir, sealed, "row-1");
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.error).toBe("bad_key");
  });

  test("a v1 value from before still opens, under the current key and after a rotation", () => {
    const a = loadKey(dir);
    const legacy = sealV1(a, "tok-v1", "row-1");
    const now = open(dir, legacy, "row-1");
    expect(now.ok && now.value).toBe("tok-v1");
    rotate(dir);
    const later = open(dir, legacy, "row-1");
    expect(later.ok && later.value).toBe("tok-v1");
    rmSync(previousKeyPath(dir));
    forgetKey(dir);
    const gone = open(dir, legacy, "row-1");
    expect(!gone.ok && gone.error).toBe("bad_key");
  });

  test("a malformed value is bad_format, and an unknown key id is bad_key", () => {
    loadKey(dir);
    const sealed = seal(dir, "tok", "row");
    const [, , iv, body] = sealed.split(":");
    expect(open(dir, `v2:XYZ:${iv}:${body}`, "row")).toMatchObject({ ok: false, error: "bad_format" });
    expect(open(dir, `v2:${iv}:${body}`, "row")).toMatchObject({ ok: false, error: "bad_format" });
    expect(open(dir, `v3:00000000:${iv}:${body}`, "row")).toMatchObject({ ok: false, error: "bad_format" });
    expect(open(dir, `v2:00000000:${iv}:${body}`, "row")).toMatchObject({ ok: false, error: "bad_key" });
  });

  test("a previous key readable by others is refused, as the current one is", () => {
    loadKey(dir);
    writeFileSync(previousKeyPath(dir), randomBytes(32), { mode: 0o644 });
    chmodSync(previousKeyPath(dir), 0o644);
    forgetKey(dir);
    expect(() => loadKeys(dir)).toThrow(/0600/);
  });

  test("a previous key of the wrong length is ignored, never used", () => {
    loadKey(dir);
    writeFileSync(previousKeyPath(dir), randomBytes(7), { mode: 0o600 });
    forgetKey(dir);
    expect(loadKeys(dir).previous).toBeNull();
  });
});
