/**
 * Signing in through another forge (#748): what this forge, as a relying
 * party, keeps. The client id it was given at the issuer (one per redirect
 * address), a sign-in in flight (the state only as a hash, so a leaked
 * database starts nothing), and which local account an issuer's `sub` is.
 * The username is never the key: it can be renamed, and a name the parent
 * frees may be taken by someone else.
 */
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../kernel/hash.ts";
import { parentUrlProblem } from "./parent_releases.ts";
import { createUser, getUserById, getUserByName, isActive, type User } from "./users.ts";
import type { SignupSlot } from "../actions/signup-window.ts";

/** Where the parent sends a person back; the address registered at the parent. */
export const CALLBACK_PATH = "/signin/parent/callback";

/** A sign-in not finished in this long is gone. */
export const LOGIN_TTL_MS = 10 * 60_000;
/** The most sign-ins in flight at once; the oldest make room. */
export const LOGIN_MAX = 1000;
/** A `sub` we accept: an id, not free text. */
export const SUB = /^[A-Za-z0-9_-]{1,64}$/;

export const clientFor = (db: Database, issuer: string, redirectUri: string): string | undefined =>
  db
    .query<{ client_id: string }, [string, string]>(
      "SELECT client_id FROM rp_client WHERE issuer = ?1 AND redirect_uri = ?2",
    )
    .get(issuer, redirectUri)?.client_id;

/** Keep the first client id for an address; a racing second registration loses. */
export function keepClient(db: Database, issuer: string, redirectUri: string, clientId: string): string {
  db.query(
    "INSERT INTO rp_client (issuer, redirect_uri, client_id) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING",
  ).run(issuer, redirectUri, clientId);
  return clientFor(db, issuer, redirectUri) ?? clientId;
}

export interface Login {
  readonly verifier: string;
  readonly nonce: string;
  readonly issuer: string;
  readonly redirectUri: string;
}

export function startLogin(db: Database, state: string, login: Login, now = Date.now()): void {
  db.query("DELETE FROM rp_login WHERE expires_at <= ?1").run(now);
  db.query(
    `DELETE FROM rp_login WHERE state_hash IN
       (SELECT state_hash FROM rp_login ORDER BY expires_at LIMIT max(0, (SELECT count(*) FROM rp_login) - ?1))`,
  ).run(LOGIN_MAX - 1);
  db.query(
    "INSERT INTO rp_login (state_hash, verifier, nonce, issuer, redirect_uri, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  ).run(sha256(state), login.verifier, login.nonce, login.issuer, login.redirectUri, now + LOGIN_TTL_MS);
}

/** The sign-in a state began, used up by asking: a state works once. */
export function takeLogin(db: Database, state: string, now = Date.now()): Login | undefined {
  const row = db
    .query<
      { verifier: string; nonce: string; issuer: string; redirect_uri: string; expires_at: number },
      [string]
    >("DELETE FROM rp_login WHERE state_hash = ?1 RETURNING verifier, nonce, issuer, redirect_uri, expires_at")
    .get(sha256(state));
  if (row === null || row.expires_at <= now) return undefined;
  return { verifier: row.verifier, nonce: row.nonce, issuer: row.issuer, redirectUri: row.redirect_uri };
}

/** A local username for a parent's person: their name if free and fit, else made unique by their `sub`. */
async function makeAccount(db: Database, sub: string, preferred: string, slot: SignupSlot): Promise<User | undefined> {
  const base = preferred.toLowerCase().replace(/[^a-z0-9.-]/g, "").replace(/^[.-]+/, "").slice(0, 30);
  const tail = sub.toLowerCase().replace(/[^a-z0-9]/g, "").slice(-8);
  for (const username of [base, `${base}-${tail}`, `user-${tail}`]) {
    if (username === "" || username.startsWith("-")) continue;
    if (getUserByName(db, username) !== undefined) continue;
    const made = await createUser(db, {
      username,
      // Unique, never mailed: `.invalid` is reserved and resolves nowhere.
      email: `${sub.toLowerCase()}@sso.invalid`,
      displayName: preferred,
      origin: "parent",
      slot,
    });
    if (made.ok) return made.value;
    if (made.error === "signup_closed") return undefined;
  }
  return undefined;
}

const making = new Map<string, Promise<User | undefined>>();

/** Whether this issuer's `sub` already has a local account: a return, not a first sight. */
export function knownIdentity(db: Database, issuer: string, sub: string): boolean {
  return (
    db
      .query<{ user_id: string }, [string, string]>(
        "SELECT user_id FROM federated_identity WHERE issuer = ?1 AND sub = ?2",
      )
      .get(issuer, sub) !== null
  );
}

/**
 * The local account for an issuer's `sub`, made on first sight with no
 * password — a stranger's sign-up, so only with a place in the sign-up
 * window and while signup is open. Two returns of the same person at once
 * make one account.
 */
export function accountFor(
  db: Database,
  issuer: string,
  sub: string,
  preferred: string,
  slot: SignupSlot | undefined,
): Promise<User | undefined> {
  const key = `${issuer}\0${sub}`;
  const pending = making.get(key);
  if (pending !== undefined) return pending;
  const attempt = (async (): Promise<User | undefined> => {
    const known = db
      .query<{ user_id: string }, [string, string]>(
        "SELECT user_id FROM federated_identity WHERE issuer = ?1 AND sub = ?2",
      )
      .get(issuer, sub);
    if (known !== null) {
      const user = getUserById(db, known.user_id);
      return user !== undefined && isActive(user) ? user : undefined;
    }
    if (slot === undefined) return undefined;
    const made = await makeAccount(db, sub, preferred, slot);
    if (made === undefined) return undefined;
    db.query("INSERT INTO federated_identity (issuer, sub, user_id) VALUES (?1, ?2, ?3)").run(
      issuer,
      sub,
      made.id,
    );
    return made;
  })();
  making.set(key, attempt);
  void attempt.finally(() => making.delete(key));
  return attempt;
}

/** The spawn record's upstream, read once per forge: it does not change while the process runs. */
const recorded = new WeakMap<object, string | undefined>();

/** The parent forge's origin: the address this forge was started with, or the spawn record's. Undefined for a forge with none. */
export function parentIssuerOf(config: {
  parentUrl?: string;
  parentLoopback?: boolean;
  dataDir: string;
}): string | undefined {
  let raw = config.parentUrl;
  if (raw === undefined) {
    if (!recorded.has(config)) {
      let upstream: string | undefined;
      try {
        const doc = JSON.parse(readFileSync(join(config.dataDir, "parent.json"), "utf8")) as { upstream?: unknown };
        if (typeof doc.upstream === "string") upstream = doc.upstream;
      } catch {
        // No record: no parent.
      }
      recorded.set(config, upstream);
    }
    raw = recorded.get(config);
  }
  if (raw === undefined || parentUrlProblem(raw, config.parentLoopback === true) !== null) return undefined;
  return new URL(raw).origin;
}
