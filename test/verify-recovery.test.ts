/**
 * Account recovery links (`core/verify.ts`): a link names its account before
 * it is spent, is spent once, and dies at expiry; `markUnproven` writes a new
 * account's unproven row and touches no other.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import {
  emailVerified,
  issueLink,
  issueRecovery,
  markUnproven,
  markVerified,
  recoveryOwner,
  resetVerification,
  RECOVERY_TTL_MS,
  spendRecovery,
} from "../src/core/verify.ts";

describe("recovery links", () => {
  let dataDir: string;
  let app: App;
  let alice: string;
  let bob: string;
  const NOW = Date.parse("2026-01-01T00:00:00Z");

  const make = async (username: string): Promise<string> => {
    const r = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!r.ok) throw new Error(r.error);
    return r.value.id;
  };
  const row = (id: string) =>
    app.db
      .query<{ verified_at: string | null }, [string]>(
        "SELECT verified_at FROM email_check WHERE user_id = ?1",
      )
      .get(id);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-recovery-"));
    app = createApp({ dataDir, port: 0 });
    alice = await make("alice");
    bob = await make("bob");
    markVerified(app.db, alice, new Date(NOW).toISOString());
    markVerified(app.db, bob, new Date(NOW).toISOString());
  });
  afterAll(async () => {
    app.db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the token names its account before it is spent", () => {
    const token = issueRecovery(app.db, alice, NOW)!;
    expect(token).toBeString();
    expect(recoveryOwner(app.db, token, NOW)).toBe(alice);
    expect(recoveryOwner(app.db, token, NOW)).toBe(alice); // reading spends nothing
    expect(spendRecovery(app.db, token, NOW)).toBe(alice);
    expect(recoveryOwner(app.db, token, NOW)).toBeUndefined();
  });

  test("a spend returns the account once, then undefined", () => {
    const token = issueRecovery(app.db, alice, NOW)!;
    expect(spendRecovery(app.db, token, NOW)).toBe(alice);
    expect(spendRecovery(app.db, token, NOW)).toBeUndefined();
  });

  test("a spend at or after expiry returns undefined; just before works", () => {
    const at = issueRecovery(app.db, alice, NOW)!;
    expect(spendRecovery(app.db, at, NOW + RECOVERY_TTL_MS)).toBeUndefined();
    expect(recoveryOwner(app.db, at, NOW + RECOVERY_TTL_MS)).toBeUndefined();
    const after = issueRecovery(app.db, alice, NOW)!;
    expect(spendRecovery(app.db, after, NOW + RECOVERY_TTL_MS + 1)).toBeUndefined();
    const before = issueRecovery(app.db, alice, NOW)!;
    expect(spendRecovery(app.db, before, NOW + RECOVERY_TTL_MS - 1)).toBe(alice);
  });

  test("an unknown or empty token returns undefined", () => {
    expect(spendRecovery(app.db, "nope", NOW)).toBeUndefined();
    expect(recoveryOwner(app.db, "nope", NOW)).toBeUndefined();
    expect(spendRecovery(app.db, "", NOW)).toBeUndefined();
    expect(recoveryOwner(app.db, "", NOW)).toBeUndefined();
  });

  test("spending one account's link leaves another's alone", () => {
    const a = issueRecovery(app.db, alice, NOW)!;
    const b = issueRecovery(app.db, bob, NOW)!;
    expect(spendRecovery(app.db, a, NOW)).toBe(alice);
    expect(recoveryOwner(app.db, b, NOW)).toBe(bob);
  });

  test("a pending verification link opens no recovery", async () => {
    const carol = await make("carol");
    resetVerification(app.db, carol); // created trusted, so proven; make it unproven
    const token = issueLink(app.db, carol, "carol@forge.local", NOW)!;
    expect(token).toBeString();
    expect(recoveryOwner(app.db, token, NOW)).toBeUndefined();
    expect(spendRecovery(app.db, token, NOW)).toBeUndefined();
    expect(issueRecovery(app.db, carol, NOW)).toBeUndefined();
  });

  test("markUnproven writes an unproven row, keeps a proven one, touches no other", async () => {
    const dan = await make("dan");
    app.db.query("DELETE FROM email_check WHERE user_id = ?1").run(dan);
    expect(row(dan)).toBeNull();
    const before = row(bob);
    markUnproven(app.db, dan);
    expect(row(dan)).toEqual({ verified_at: null });
    expect(emailVerified(app.db, dan)).toBe(false);
    expect(row(bob)).toEqual(before);
    expect(emailVerified(app.db, bob)).toBe(true);
    markUnproven(app.db, bob); // never un-proves an existing row
    expect(row(bob)).toEqual(before);
  });
});
