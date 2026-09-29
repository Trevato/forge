/**
 * Prompt sources: where a repository's next tell comes from when nobody is
 * typing. One kind so far — an Instagram account whose latest Reel's top
 * comment becomes the crew's next tell, once a day (docs/APPS.md, "Prompts
 * from Instagram").
 *
 * The token is sealed at rest under the forge's key, bound to the row it
 * belongs to, and opened only for the run; nothing here ever returns it in
 * a listing. Pure data: no Instagram, no authz, no events — the routine in
 * `crew/prompts.ts` does the asking, and `actions/prompts.ts` the deciding.
 */

import type { Database } from "bun:sqlite";
import { id } from "../kernel/id.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { open, seal, type OpenError } from "../kernel/secret.ts";

export type PromptKind = "instagram";

export interface PromptSource {
  readonly id: string;
  readonly repoId: string;
  readonly kind: PromptKind;
  /** The account's username, learnt on the first run; empty until then. */
  readonly account: string;
  /** When the routine runs each day, `HH:MM` in UTC. */
  readonly atUtc: string;
  /** When the sealed token was pasted or last refreshed. */
  readonly tokenRefreshedAt: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly lastRanAt: string | null;
  /** What the last run said, one sentence for a person. */
  readonly lastSaid: string;
  /** The Reel already told about, so the same one is never told twice. */
  readonly lastMediaId: string | null;
  readonly lastIssueNumber: number | null;
}

interface Row {
  id: string;
  repo_id: string;
  kind: string;
  account: string;
  at_utc: string;
  token_refreshed_at: string;
  created_by: string | null;
  created_at: string;
  last_ran_at: string | null;
  last_said: string;
  last_media_id: string | null;
  last_issue_number: number | null;
}

/** Every column but the sealed token: what a listing may carry. */
const COLUMNS = `id, repo_id, kind, account, at_utc, token_refreshed_at, created_by,
  created_at, last_ran_at, last_said, last_media_id, last_issue_number`;

const toSource = (r: Row): PromptSource => ({
  id: r.id,
  repoId: r.repo_id,
  kind: "instagram",
  account: r.account,
  atUtc: r.at_utc,
  tokenRefreshedAt: r.token_refreshed_at,
  createdBy: r.created_by,
  createdAt: r.created_at,
  lastRanAt: r.last_ran_at,
  lastSaid: r.last_said,
  lastMediaId: r.last_media_id,
  lastIssueNumber: r.last_issue_number,
});

const aad = (sourceId: string): string => `prompt-source:${sourceId}`;

const TOKEN_MAX = 1024;

export type AddPromptError = "invalid_at" | "invalid_token";

/** `HH:MM`, twenty-four hours, both parts zero-padded. */
export function isDailyTime(at: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(at);
}

/**
 * A token as Instagram hands one out: printable, no spaces, not absurdly
 * long. Its shape is otherwise Instagram's business; the first run finds
 * out whether it is accepted, and says so.
 */
export function isPromptToken(token: string): boolean {
  return (
    token.length > 0 &&
    token.length <= TOKEN_MAX &&
    /^[\x21-\x7e]+$/.test(token)
  );
}

export function addPromptSource(
  db: Database,
  dataDir: string,
  input: {
    repoId: string;
    kind: PromptKind;
    token: string;
    atUtc: string;
    createdBy?: string | undefined;
    now?: Date | undefined;
  },
): Result<PromptSource, AddPromptError> {
  const atUtc = input.atUtc.trim();
  if (!isDailyTime(atUtc)) return err("invalid_at");
  const token = input.token.trim();
  if (!isPromptToken(token)) return err("invalid_token");
  const sourceId = id();
  const at = (input.now ?? new Date()).toISOString();
  db.query(
    `INSERT INTO prompt_source (id, repo_id, kind, token_enc, token_refreshed_at, at_utc, created_by, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?5)`,
  ).run(
    sourceId,
    input.repoId,
    input.kind,
    seal(dataDir, token, aad(sourceId)),
    at,
    atUtc,
    input.createdBy ?? null,
  );
  return ok(getPromptSource(db, sourceId)!);
}

export function getPromptSource(
  db: Database,
  sourceId: string,
): PromptSource | undefined {
  const row = db
    .query<Row, [string]>(`SELECT ${COLUMNS} FROM prompt_source WHERE id = ?1`)
    .get(sourceId);
  return row ? toSource(row) : undefined;
}

/** A repository's sources, oldest first. */
export function listPromptSources(
  db: Database,
  repoId: string,
): PromptSource[] {
  return db
    .query<
      Row,
      [string]
    >(`SELECT ${COLUMNS} FROM prompt_source WHERE repo_id = ?1 ORDER BY created_at, id`)
    .all(repoId)
    .map(toSource);
}

/**
 * The sources whose time has come today: `at_utc` at or before the clock's
 * `HH:MM`, and no run yet on the clock's date. A forge that was down at the
 * hour catches up on its next tick; one that ran already waits for tomorrow.
 */
export function duePromptSources(db: Database, now: Date): PromptSource[] {
  const iso = now.toISOString();
  return db
    .query<Row, [string, string]>(
      `SELECT ${COLUMNS} FROM prompt_source
       WHERE at_utc <= ?1 AND (last_ran_at IS NULL OR substr(last_ran_at, 1, 10) <> ?2)
       ORDER BY at_utc, created_at, id`,
    )
    .all(iso.slice(11, 16), iso.slice(0, 10))
    .map(toSource);
}

/**
 * Claim a source for a run, atomically: the row's `last_ran_at` moves to now
 * only if it has not run today — or unconditionally for a person's "Fetch
 * now". False means another run has it; the caller does nothing more.
 */
export function claimPromptRun(
  db: Database,
  sourceId: string,
  now: Date,
  o: { force?: boolean | undefined } = {},
): boolean {
  const iso = now.toISOString();
  const result = db
    .query(
      `UPDATE prompt_source SET last_ran_at = ?2
       WHERE id = ?1
         AND (?3 = 1 OR last_ran_at IS NULL OR substr(last_ran_at, 1, 10) <> substr(?2, 1, 10))`,
    )
    .run(sourceId, iso, o.force ? 1 : 0);
  return result.changes === 1;
}

/** The token, for a run. A value that will not open says so, never a throw. */
export function openPromptToken(
  db: Database,
  dataDir: string,
  sourceId: string,
): Result<string, "not_found" | OpenError> {
  const row = db
    .query<
      { token_enc: string },
      [string]
    >("SELECT token_enc FROM prompt_source WHERE id = ?1")
    .get(sourceId);
  if (!row) return err("not_found");
  return open(dataDir, row.token_enc, aad(sourceId));
}

/** After a refresh: the new token sealed, and the moment noted. */
export function storePromptToken(
  db: Database,
  dataDir: string,
  sourceId: string,
  token: string,
  now: Date,
): void {
  db.query(
    "UPDATE prompt_source SET token_enc = ?2, token_refreshed_at = ?3 WHERE id = ?1",
  ).run(sourceId, seal(dataDir, token, aad(sourceId)), now.toISOString());
}

export function setPromptAccount(
  db: Database,
  sourceId: string,
  username: string,
): void {
  db.query("UPDATE prompt_source SET account = ?2 WHERE id = ?1").run(
    sourceId,
    username,
  );
}

/**
 * What a run came to. The media id and the issue number are written only
 * when a Reel was actually told — a Reel with no comments yet leaves them
 * alone, so tomorrow's run looks at the same Reel again.
 */
export function recordPromptRun(
  db: Database,
  sourceId: string,
  run: {
    said: string;
    mediaId?: string | undefined;
    issueNumber?: number | undefined;
    now: Date;
  },
): PromptSource | undefined {
  db.query(
    `UPDATE prompt_source
       SET last_ran_at = ?2,
           last_said = ?3,
           last_media_id = COALESCE(?4, last_media_id),
           last_issue_number = COALESCE(?5, last_issue_number)
     WHERE id = ?1`,
  ).run(
    sourceId,
    run.now.toISOString(),
    run.said.slice(0, 400),
    run.mediaId ?? null,
    run.issueNumber ?? null,
  );
  return getPromptSource(db, sourceId);
}

export function removePromptSource(db: Database, sourceId: string): boolean {
  return (
    db.query("DELETE FROM prompt_source WHERE id = ?1").run(sourceId).changes >
    0
  );
}
