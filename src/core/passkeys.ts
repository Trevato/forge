/**
 * Passkeys an account has registered: the public half only, several per
 * account. Verification lives in `auth/webauthn.ts`; this is what is kept.
 */

import type { Database } from "bun:sqlite";
import type { Alg, Credential, Jwk } from "../auth/webauthn.ts";
import { id as newId } from "../kernel/id.ts";
import { err, ok, type Result } from "../kernel/result.ts";

/** More than this is a script, not a person's devices. */
export const PASSKEY_MAX = 20;
export const PASSKEY_NAME_MAX = 60;

export interface PasskeyInfo {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

interface Row {
  id: string;
  user_id: string;
  credential_id: string;
  name: string;
  alg: Alg;
  key: string;
  sign_count: number;
  created_at: string;
  last_used_at: string | null;
}

export function listPasskeys(db: Database, userId: string): PasskeyInfo[] {
  return db
    .query<Row, [string]>(
      "SELECT * FROM passkey WHERE user_id = ?1 ORDER BY created_at, id",
    )
    .all(userId)
    .map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    }));
}

/** The credential ids of an account, so a device is not enrolled twice. */
export function passkeyIds(db: Database, userId: string): string[] {
  return db
    .query<{ credential_id: string }, [string]>(
      "SELECT credential_id FROM passkey WHERE user_id = ?1",
    )
    .all(userId)
    .map((r) => r.credential_id);
}

export function addPasskey(
  db: Database,
  userId: string,
  name: string,
  credential: Credential,
): Result<string, "too_many" | "duplicate"> {
  const count = db
    .query<{ n: number }, [string]>(
      "SELECT count(*) AS n FROM passkey WHERE user_id = ?1",
    )
    .get(userId)!.n;
  if (count >= PASSKEY_MAX) return err("too_many");
  const id = newId();
  try {
    db.query(
      `INSERT INTO passkey (id, user_id, credential_id, name, alg, key, sign_count)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).run(
      id,
      userId,
      credential.id,
      name.slice(0, PASSKEY_NAME_MAX),
      credential.alg,
      JSON.stringify(credential.key),
      credential.signCount,
    );
  } catch {
    return err("duplicate");
  }
  return ok(id);
}

/** Remove one of the account's own passkeys. False when it is not theirs. */
export function removePasskey(
  db: Database,
  userId: string,
  passkeyId: string,
): boolean {
  return (
    db
      .query("DELETE FROM passkey WHERE id = ?1 AND user_id = ?2")
      .run(passkeyId, userId).changes > 0
  );
}

/** The account and verification material behind a credential id. */
export function findPasskey(
  db: Database,
  credentialId: string,
): { id: string; userId: string; credential: Credential } | undefined {
  const r = db
    .query<Row, [string]>("SELECT * FROM passkey WHERE credential_id = ?1")
    .get(credentialId);
  if (!r) return undefined;
  return {
    id: r.id,
    userId: r.user_id,
    credential: {
      id: r.credential_id,
      alg: r.alg,
      key: JSON.parse(r.key) as Jwk,
      signCount: r.sign_count,
    },
  };
}

export function notePasskeyUsed(
  db: Database,
  passkeyId: string,
  signCount: number,
): void {
  db.query(
    "UPDATE passkey SET sign_count = ?2, last_used_at = ?3 WHERE id = ?1",
  ).run(passkeyId, signCount, new Date().toISOString());
}
