/**
 * Open pulls whose crew reviewer's latest word is "changes requested"
 * (#2172): one read, for the tick that moves them (`crew/requested.ts`)
 * and for /flow that shows them waiting (`flow/requested.ts`), so the two
 * can never disagree about which pulls these are.
 *
 * "Latest" is the newest verdict any reviewer on the pull's crew passed on
 * it, whatever head it was on: a verdict on an older head is the one a
 * push has not been read against yet. An imported review is an origin's,
 * never the crew's. Pure data: no authz, no events.
 */

import type { Database } from "bun:sqlite";

export interface RequestedPull {
  readonly repoId: string;
  /** `owner/name`. */
  readonly repo: string;
  /** Whether the repository is public: a reader kept from private names sees only these. */
  readonly isPublic: number;
  readonly pullId: string;
  readonly number: number;
  readonly headOid: string;
  /** The head the verdict was passed on. */
  readonly reviewedOid: string;
  readonly reviewerId: string;
  /** When the verdict was passed. */
  readonly at: string;
}

/** Oldest verdict first; one repository's when `repoId` is given, else every one's. */
export function requestedPulls(db: Database, repoId?: string): RequestedPull[] {
  return db
    .query<RequestedPull, [string | null]>(
      `SELECT i.repo_id AS repoId, o.username || '/' || r.name AS repo,
              r.visibility = 'public' AS isPublic,
              i.id AS pullId, i.number AS number, p.head_oid AS headOid,
              v.commit_oid AS reviewedOid, v.author_id AS reviewerId, v.created_at AS at
         FROM issue i JOIN pull p ON p.issue_id = i.id
         JOIN repo r ON r.id = i.repo_id JOIN user o ON o.id = r.owner_id
         JOIN review v ON v.id = (
           SELECT w.id FROM review w
             JOIN repo_crew c ON c.repo_id = i.repo_id AND c.user_id = w.author_id
            WHERE w.issue_id = i.id AND c.role = 'reviewer' AND w.origin_author IS NULL
            ORDER BY w.id DESC LIMIT 1)
        WHERE i.kind = 'pull' AND i.state = 'open' AND p.merged_at IS NULL
          AND v.state = 'changes_requested'
          AND (?1 IS NULL OR i.repo_id = ?1)
        ORDER BY v.created_at, i.number`,
    )
    .all(repoId ?? null);
}

/** Whether a push has come since the verdict: the reviewer owes the next word, not the builder. */
export const verdictIsStale = (p: RequestedPull): boolean =>
  p.reviewedOid !== p.headOid;
