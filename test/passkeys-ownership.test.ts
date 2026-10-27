/**
 * A passkey belongs to its account: removal never crosses accounts, lookup
 * names the owner, a use touches only its own credential, and an account
 * holds at most PASSKEY_MAX.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Credential } from "../src/auth/webauthn.ts";
import {
  addPasskey, findPasskey, listPasskeys, notePasskeyUsed, PASSKEY_MAX,
  passkeyIds, passkeyRoom, removePasskey,
} from "../src/core/passkeys.ts";
import { migrations } from "../src/core/schema.ts";
import { openDb } from "../src/kernel/db.ts";

let db: Database;

const cred = (id: string, signCount = 0): Credential => ({
  id,
  alg: "ES256",
  key: { kty: "EC", crv: "P-256", x: "x", y: "y" },
  signCount,
});

function user(id: string) {
  db.query("INSERT INTO user (id, username, email, password_hash) VALUES (?1, ?1, ?1 || '@x.test', 'x')").run(id);
}

/** Two accounts with one passkey each; returns the row ids. */
function two() {
  user("a");
  user("b");
  const a = addPasskey(db, "a", "A phone", cred("cred-a", 1));
  const b = addPasskey(db, "b", "B key", cred("cred-b", 2));
  if (!a.ok || !b.ok) throw new Error("setup");
  return { a: a.value, b: b.value };
}

beforeEach(() => {
  db = openDb(":memory:", migrations);
});

describe("passkey ownership", () => {
  test("removePasskey only removes the account's own", () => {
    const k = two();
    expect(removePasskey(db, "a", k.b)).toBe(false);
    expect(listPasskeys(db, "b").map((p) => p.id)).toEqual([k.b]);
    expect(listPasskeys(db, "a")).toHaveLength(1);
    expect(removePasskey(db, "a", k.a)).toBe(true);
    expect(listPasskeys(db, "a")).toEqual([]);
    expect(listPasskeys(db, "b")).toHaveLength(1);
  });

  test("findPasskey returns the owner; an unknown id is undefined", () => {
    const k = two();
    const found = findPasskey(db, "cred-b");
    expect(found?.id).toBe(k.b);
    expect(found?.userId).toBe("b");
    expect(found?.credential).toEqual(cred("cred-b", 2));
    expect(findPasskey(db, "cred-a")?.userId).toBe("a");
    expect(findPasskey(db, "nope")).toBeUndefined();
    expect(passkeyIds(db, "a")).toEqual(["cred-a"]);
  });

  test("notePasskeyUsed touches only that credential", () => {
    const k = two();
    notePasskeyUsed(db, k.a, 9);
    expect(findPasskey(db, "cred-a")?.credential.signCount).toBe(9);
    expect(findPasskey(db, "cred-b")?.credential.signCount).toBe(2);
    expect(listPasskeys(db, "a")[0]!.lastUsedAt).not.toBeNull();
    expect(listPasskeys(db, "b")[0]!.lastUsedAt).toBeNull();
  });

  test("passkeyRoom says no at the most, and for a taken credential", () => {
    const k = two();
    expect(passkeyRoom(db, "a", "fresh").ok).toBe(true);
    expect(passkeyRoom(db, "a", "cred-b")).toEqual({ ok: false, error: "duplicate" });
    for (let i = 1; i < PASSKEY_MAX; i++) addPasskey(db, "a", `n${i}`, cred(`more-${i}`));
    expect(listPasskeys(db, "a")).toHaveLength(PASSKEY_MAX);
    expect(passkeyRoom(db, "a", "fresh")).toEqual({ ok: false, error: "too_many" });
    expect(passkeyRoom(db, "b", "fresh").ok).toBe(true);
    expect(k.a).toBeTruthy();
  });
});
