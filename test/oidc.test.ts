/**
 * OpenID Connect keys: a token signed before a rotation still verifies
 * after it, the JWKS holds the current key and the previous one, and a
 * token that is expired, forged or for another audience does not verify.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrations } from "../src/core/schema.ts";
import { openDb } from "../src/kernel/db.ts";
import { jwks, rotateKeys, signIdToken, signingKey, verifyIdToken, ID_TOKEN_TTL_S, ROTATE_MS } from "../src/core/oidc.ts";
import { createUser } from "../src/core/users.ts";

const setup = async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-oidc-"));
  const db = openDb(":memory:", migrations);
  const made = await createUser(db, {
    origin: "seed",
    trusted: true,
    username: "bob",
    email: "bob@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  return { db, dir, user: made.value };
};
const expectFor = { issuer: "https://forge.test", clientId: "c1" };

describe("oidc keys", () => {
  test("a token signed with the previous key verifies until it expires", async () => {
    const { db, dir, user } = await setup();
    const t0 = Date.now();
    const old = await signIdToken(db, dir, { ...expectFor, user, scopes: ["openid"], nonce: "n" }, t0);
    const [first] = (await jwks(db, dir)).keys;
    await rotateKeys(db, dir, t0 + 1000);
    const keys = (await jwks(db, dir)).keys;
    expect(keys.length).toBe(2);
    expect(keys.map((k) => k["kid"])).toContain(first!["kid"]);
    expect((await verifyIdToken(db, dir, old, expectFor, t0 + 2000)).ok).toBe(true);
    expect((await verifyIdToken(db, dir, old, expectFor, t0 + (ID_TOKEN_TTL_S + 1) * 1000)).ok).toBe(false);
    // A token from the new key carries the new kid.
    const fresh = await signIdToken(db, dir, { ...expectFor, user, scopes: ["openid"], nonce: "" }, t0 + 3000);
    expect(JSON.parse(Buffer.from(fresh.split(".")[0]!, "base64url").toString()).kid).toBe(keys[0]!["kid"]);
  });

  test("only the current and previous keys are kept; an old key rotates itself", async () => {
    const { db, dir, user } = await setup();
    const t0 = Date.now();
    await signIdToken(db, dir, { ...expectFor, user, scopes: ["openid"], nonce: "" }, t0);
    await rotateKeys(db, dir, t0 + 1);
    await rotateKeys(db, dir, t0 + 2);
    expect((await jwks(db, dir)).keys.length).toBe(2);
    const before = (await jwks(db, dir)).keys[0]!["kid"];
    await signIdToken(db, dir, { ...expectFor, user, scopes: ["openid"], nonce: "" }, t0 + ROTATE_MS + 10);
    expect((await jwks(db, dir)).keys[0]!["kid"]).not.toBe(before);
  });

  test("two requests racing past the rotation mark share one new key", async () => {
    const { db, dir } = await setup();
    const t0 = Date.now();
    const first = await signingKey(db, dir, t0);
    const [a, b] = await Promise.all([
      signingKey(db, dir, t0 + ROTATE_MS + 1),
      signingKey(db, dir, t0 + ROTATE_MS + 1),
    ]);
    expect(a.kid).toBe(b.kid);
    expect(a.kid).not.toBe(first.kid);
    // The keep-two prune did not drop the key that was still signing.
    const kids = (await jwks(db, dir)).keys.map((k) => k["kid"]);
    expect(kids).toContain(first.kid);
    expect(kids).toContain(a.kid);
  });

  test("a forged, mis-addressed or malformed token is refused", async () => {
    const { db, dir, user } = await setup();
    const jwt = await signIdToken(db, dir, { ...expectFor, user, scopes: ["openid"], nonce: "" });
    const [h, p, s] = jwt.split(".");
    const tampered = `${h}.${Buffer.from(JSON.stringify({ sub: "root" })).toString("base64url")}.${s}`;
    expect((await verifyIdToken(db, dir, tampered, expectFor)).ok).toBe(false);
    expect((await verifyIdToken(db, dir, jwt, { ...expectFor, clientId: "other" })).ok).toBe(false);
    expect((await verifyIdToken(db, dir, jwt, { ...expectFor, issuer: "https://evil" })).ok).toBe(false);
    expect((await verifyIdToken(db, dir, `${h}.${p}`, expectFor)).ok).toBe(false);
    expect((await verifyIdToken(db, dir, "a.b.c", expectFor)).ok).toBe(false);
  });

  test("the private key is sealed in the database, never a JWK", async () => {
    const { db, dir, user } = await setup();
    const jwt = await signIdToken(db, dir, { ...expectFor, user, scopes: ["openid"], nonce: "" });
    const rows = db.query<{ private_jwk: string }, []>("SELECT private_jwk FROM oidc_key").all();
    expect(rows.length).toBe(1);
    for (const r of rows) {
      expect(r.private_jwk.startsWith("v2:")).toBe(true);
      expect(r.private_jwk).not.toContain('"d"');
      expect(() => JSON.parse(r.private_jwk)).toThrow();
    }
    expect((await verifyIdToken(db, dir, jwt, expectFor)).ok).toBe(true);
  });

  test("a sealed key lifted onto another kid does not sign", async () => {
    const { db, dir, user } = await setup();
    await signIdToken(db, dir, { ...expectFor, user, scopes: ["openid"], nonce: "" });
    db.query("UPDATE oidc_key SET kid = 'other'").run();
    await expect(
      signIdToken(db, dir, { ...expectFor, user, scopes: ["openid"], nonce: "" }),
    ).rejects.toThrow();
  });
});
