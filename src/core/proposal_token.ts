/**
 * Proposal tokens: a credential a writer of a parent repository hands to
 * one named child. It is a `rw` token for the writer that minted it, but
 * the gate in `http/proposal_gate.ts` lets it do exactly three things — read
 * this one repository (so the child's forge can fork and follow it), push
 * branches under `child/<name>/` and open a pull from one. This module is
 * the data and the rules about names; it decides nothing about requests.
 */

import type { Database } from "bun:sqlite";
import { isSafeRef } from "../git/guard.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { createToken } from "./tokens.ts";
import { foldsIn } from "./trusted_sources.ts";

export interface Proposal {
  readonly tokenId: string;
  readonly repoId: string;
  readonly child: string;
  readonly origin: string;
  /** A follow token: it fetches this one repository and does nothing else. */
  readonly readOnly?: boolean;
}

/** How long a proposal token lives: a child re-mints rather than keeps one. */
export const PROPOSAL_TTL_MS = 30 * 24 * 3600_000;
/** The most a proposal request may carry as a body. */
export const PROPOSAL_BODY_MAX = 64 * 1024;

/** A child's name: lowercase words joined by hyphens, short. */
export const isChildName = (name: string): boolean =>
  /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(name);

/** Where a child lives: an https address with no credentials, no controls. */
export function parseOrigin(raw: string): string | undefined {
  if (raw.length === 0 || raw.length > 200) return undefined;
  if (/[\x00-\x20\x7f\\]/.test(raw)) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "")
    return undefined;
  if (url.hash !== "" || url.search !== "") return undefined;
  return url.href;
}

/**
 * Whether `ref` (full `refs/heads/…`) is a branch inside the child's
 * namespace, `child/<name>/…`, with nothing in it git or a path could read
 * as a way out: every segment plain, no dots-only, no control characters.
 */
export function inNamespace(ref: string, child: string): boolean {
  const prefix = `refs/heads/child/${child}/`;
  if (!ref.startsWith(prefix) || ref.length > 200) return false;
  if (!isSafeRef(ref)) return false;
  const rest = ref.slice(prefix.length).split("/");
  return rest.every(
    (part) => /^[A-Za-z0-9._-]+$/.test(part) && !/^\.+$/.test(part),
  );
}

/** A pull's head, as the API names it (no `refs/heads/`), in the namespace. */
export const headInNamespace = (head: string, child: string): boolean =>
  inNamespace(`refs/heads/${head}`, child);

export function mintProposalToken(
  db: Database,
  userId: string,
  repoId: string,
  input: { child: string; origin: string; childRepoId?: string; readOnly?: boolean },
  now: number = Date.now(),
): Result<{ id: string; token: string }, "invalid_child" | "invalid_origin"> {
  if (!isChildName(input.child)) return err("invalid_child");
  const origin = parseOrigin(input.origin);
  if (origin === undefined) return err("invalid_origin");
  // A follow token is read-only and has no end date: a child that follows an app must keep
  // reading it without anyone remembering a renewal; the parent ends it (`revokeFollowTokens`)
  // and so does the child's sever.
  const readOnly = input.readOnly === true;
  const minted = createToken(db, userId, `${readOnly ? "follow" : "proposal"}:${input.child}`, "rw", {
    ...(readOnly ? {} : { expiresAt: new Date(now + PROPOSAL_TTL_MS).toISOString() }),
  });
  db.query(
    "INSERT INTO proposal_token (token_id, repo_id, child, child_repo_id, origin, read_only) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  ).run(minted.id, repoId, input.child, input.childRepoId ?? null, origin, readOnly ? 1 : 0);
  return ok(minted);
}

/** End every follow token a child holds for one repository; how many ended. */
export function revokeFollowTokens(db: Database, repoId: string, child: string): number {
  return db
    .query(
      `DELETE FROM token WHERE id IN
         (SELECT token_id FROM proposal_token WHERE repo_id = ?1 AND child = ?2 AND read_only = 1)`,
    )
    .run(repoId, child).changes;
}

/** How many live follow tokens a child holds for one repository. */
export function followTokenCount(db: Database, repoId: string, child: string): number {
  return db
    .query<{ n: number }, [string, string]>(
      "SELECT COUNT(*) AS n FROM proposal_token WHERE repo_id = ?1 AND child = ?2 AND read_only = 1",
    )
    .get(repoId, child)!.n;
}

/** What a token is limited to, or undefined for an ordinary token. */
export function proposalOf(db: Database, tokenId: string): Proposal | undefined {
  const row = db
    .query<
      { token_id: string; repo_id: string; child: string; origin: string; read_only: number },
      [string]
    >("SELECT token_id, repo_id, child, origin, read_only FROM proposal_token WHERE token_id = ?1")
    .get(tokenId);
  return row
    ? {
        tokenId: row.token_id,
        repoId: row.repo_id,
        child: row.child,
        origin: row.origin,
        ...(row.read_only === 1 ? { readOnly: true } : {}),
      }
    : undefined;
}

/** The one line every surface says of a proposed pull. */
export const proposedByText = (p: { child: string; origin: string; folds?: boolean }): string =>
  `proposed by child ${p.child} from ${p.origin}` +
  (p.folds === true ? `, trusted as child:${p.child} (trusted sources), so its checks run` : "");

export function recordPullProposal(
  db: Database,
  issueId: string,
  p: Pick<Proposal, "child" | "origin">,
): void {
  db.query(
    "INSERT OR REPLACE INTO pull_proposal (issue_id, child, origin) VALUES (?1, ?2, ?3)",
  ).run(issueId, p.child, p.origin);
}

export function pullProposalOf(
  db: Database,
  issueId: string,
): { child: string; origin: string; folds: boolean } | undefined {
  const row = db
    .query<{ child: string; origin: string }, [string]>(
      "SELECT child, origin FROM pull_proposal WHERE issue_id = ?1",
    )
    .get(issueId);
  return row === null ? undefined : { ...row, folds: foldsIn(db, issueId) };
}

export interface ProposalTokenInfo {
  readonly id: string;
  readonly child: string;
  readonly origin: string;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
}

/** The proposal tokens one person minted for one repository, oldest first. */
export function listProposalTokens(
  db: Database,
  userId: string,
  repoId: string,
): ProposalTokenInfo[] {
  return db
    .query<
      {
        id: string;
        child: string;
        origin: string;
        created_at: string;
        expires_at: string | null;
        last_used_at: string | null;
      },
      [string, string]
    >(
      `SELECT t.id, p.child, p.origin, t.created_at, t.expires_at, t.last_used_at
         FROM proposal_token p JOIN token t ON t.id = p.token_id
        WHERE t.user_id = ?1 AND p.repo_id = ?2 ORDER BY t.id`,
    )
    .all(userId, repoId)
    .map((r) => ({
      id: r.id,
      child: r.child,
      origin: r.origin,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      lastUsedAt: r.last_used_at,
    }));
}

/** End one proposal token of this person's for this repository. */
export function deleteProposalToken(
  db: Database,
  userId: string,
  repoId: string,
  tokenId: string,
): boolean {
  return (
    db
      .query(
        `DELETE FROM token WHERE id = ?1 AND user_id = ?2
           AND id IN (SELECT token_id FROM proposal_token WHERE repo_id = ?3)`,
      )
      .run(tokenId, userId, repoId).changes > 0
  );
}
