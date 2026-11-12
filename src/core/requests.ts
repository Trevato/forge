/**
 * A stranger's request for an account (#10928): the note they left, where
 * the ask came from, and the admin's answer. The account itself waits
 * (`user.waiting_at`, which `isActive` reads); Allow clears that, Decline
 * keeps the record and the account stays unable to act. Plain data in and
 * out: who may answer is `actions/requests.ts`'s to say.
 */

import type { Database } from "bun:sqlite";

export type RequestState = "waiting" | "allowed" | "declined";

export interface AccountRequest {
  readonly username: string;
  readonly note: string;
  /** Where the ask came from: a forge or an agent's name, or empty for the web. */
  readonly source: string;
  readonly state: RequestState;
  readonly askedAt: string;
  readonly decidedAt: string | null;
}

/** Requests that may wait at once: past this, a stranger meets the closed door until the admin answers some. */
export const WAITING_CAP = 200;
export const NOTE_MAX = 500;
export const SOURCE_MAX = 80;

/** A note or source from untrusted input: one trimmed line of text, capped, no control characters. */
export function cleanAsk(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
}

interface Row {
  username: string;
  note: string;
  source: string;
  state: RequestState;
  asked_at: string;
  decided_at: string | null;
}

const SELECT = `SELECT u.username, r.note, r.source, r.state, r.asked_at, r.decided_at
                  FROM account_request r JOIN user u ON u.id = r.user_id`;

const toRequest = (r: Row): AccountRequest => ({
  username: r.username,
  note: r.note,
  source: r.source,
  state: r.state,
  askedAt: r.asked_at,
  decidedAt: r.decided_at,
});

/** Who waits, oldest first: the admin answers in the order they asked. */
export function waitingRequests(db: Database): AccountRequest[] {
  return db
    .query<Row, []>(`${SELECT} WHERE r.state = 'waiting' AND u.removed_at IS NULL ORDER BY r.asked_at, u.username`)
    .all()
    .map(toRequest);
}

export function waitingCount(db: Database): number {
  return (
    db
      .query<{ n: number }, []>("SELECT count(*) AS n FROM account_request WHERE state = 'waiting'")
      .get()?.n ?? 0
  );
}

export function requestOf(db: Database, userId: string): AccountRequest | undefined {
  const row = db.query<Row, [string]>(`${SELECT} WHERE r.user_id = ?1`).get(userId);
  return row === null ? undefined : toRequest(row);
}

/**
 * Answer a waiting request: Allow clears the wait, Decline keeps it. Only a
 * request still waiting can be answered, so two taps answer once. Returns
 * the request as it now stands, or undefined when none was waiting.
 */
export function answerRequest(
  db: Database,
  username: string,
  state: "allowed" | "declined",
  by: string,
  at: string,
): AccountRequest | undefined {
  return db.transaction((): AccountRequest | undefined => {
    const found = db
      .query<{ user_id: string }, [string]>(
        `SELECT r.user_id FROM account_request r JOIN user u ON u.id = r.user_id
          WHERE u.username = ?1 COLLATE NOCASE AND r.state = 'waiting'`,
      )
      .get(username);
    if (found === null) return undefined;
    db.query("UPDATE account_request SET state = ?1, decided_at = ?2, decided_by = ?3 WHERE user_id = ?4").run(
      state,
      at,
      by,
      found.user_id,
    );
    if (state === "allowed") db.query("UPDATE user SET waiting_at = NULL WHERE id = ?1").run(found.user_id);
    return requestOf(db, found.user_id);
  })();
}

/**
 * Whether this account has an answer it has not been told yet; telling it
 * (`markTold`) is once, so "You're in" is said on one sign-in.
 */
export function untoldAnswer(db: Database, userId: string): RequestState | undefined {
  const row = db
    .query<{ state: RequestState }, [string]>(
      "SELECT state FROM account_request WHERE user_id = ?1 AND state <> 'waiting' AND told_at IS NULL",
    )
    .get(userId);
  return row?.state;
}

export function markTold(db: Database, userId: string, at: string): void {
  db.query("UPDATE account_request SET told_at = ?1 WHERE user_id = ?2 AND told_at IS NULL").run(at, userId);
}
