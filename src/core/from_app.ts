/**
 * An issue a person sent from an app (#10365, sandbox-game#18): the forge
 * button in an app files it in the owner's name under this label
 * (`actions/app_notes.ts`). It is a person's ask, and it is read ahead of
 * the crew's own picks (`next_up.ts`) and starts ahead of them
 * (`crew/people_first.ts`): one sat for eighteen hours behind polish.
 */

import type { Database } from "bun:sqlite";
import { labelsForIssues } from "./issues.ts";

export const FROM_APP_LABEL = "from-app";

/** Of `issueIds`, the ones labelled `from-app`. */
export function fromAppIssues(
  db: Database,
  issueIds: readonly string[],
): Set<string> {
  if (issueIds.length === 0) return new Set();
  const out = new Set<string>();
  for (const [id, labels] of labelsForIssues(db, issueIds))
    if (labels.some((l) => l.name.toLowerCase() === FROM_APP_LABEL))
      out.add(id);
  return out;
}

/** A `from-app` issue a person with an account sent that is still open. */
export interface WaitingFromApp {
  readonly repoId: string;
  /** `owner/name`. */
  readonly repo: string;
  readonly number: number;
  readonly createdAt: string;
  readonly assigned: boolean;
  /** The newest comment by a crew member, or null when none has spoken. */
  readonly lastCrewAt: string | null;
}

/**
 * The open `from-app` issues sent by a person with an account (the note's
 * sender key starts `u:`), oldest first, hidden notes left out. A stranger's
 * note stays a suggestion until a writer adopts it (`crew/direct.ts`); only a
 * person's is owed an answer. `repoId` narrows to one repository.
 */
export function waitingFromApp(db: Database, repoId?: string): WaitingFromApp[] {
  const rows = db
    .query<
      { repo_id: string; repo: string; number: number; created_at: string; assignee_id: string | null; last_crew: string | null },
      [string | null, string]
    >(
      `SELECT i.repo_id, o.username || '/' || r.name AS repo, i.number, i.created_at, i.assignee_id,
              (SELECT MAX(c.created_at) FROM comment c JOIN user u ON u.id = c.author_id
                WHERE c.issue_id = i.id AND u.is_agent = 1) AS last_crew
         FROM issue i
         JOIN repo r ON r.id = i.repo_id
         JOIN user o ON o.id = r.owner_id
         JOIN app_note n ON n.repo_id = i.repo_id AND n.issue_number = i.number
         JOIN issue_label il ON il.issue_id = i.id
         JOIN label l ON l.id = il.label_id AND l.name = ?2 COLLATE NOCASE
        WHERE i.kind = 'issue' AND i.state = 'open' AND n.hidden = 0 AND n.visitor LIKE 'u:%'
          AND (?1 IS NULL OR i.repo_id = ?1)
        GROUP BY i.id
        ORDER BY i.created_at, i.id`,
    )
    .all(repoId ?? null, FROM_APP_LABEL);
  return rows.map((r) => ({
    repoId: r.repo_id,
    repo: r.repo,
    number: r.number,
    createdAt: r.created_at,
    assigned: r.assignee_id !== null,
    lastCrewAt: r.last_crew,
  }));
}

/** Of a repository's waiting `from-app` issues, the oldest no crew member has answered; none when all were. */
export function unansweredFromApp(db: Database, repoId: string): WaitingFromApp | undefined {
  return waitingFromApp(db, repoId).find((w) => w.lastCrewAt === null);
}
