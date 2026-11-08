/**
 * The "repeating issue" flow alarm (#8707): an issue parked by the repeat stop
 * (`crew/repeat.ts`) whose note is still its newest word, so no person has
 * answered. One alarm, naming the one parked longest. Home and /boards draw it.
 */

import type { Database } from "bun:sqlite";
import { REPEAT_NOTE } from "../crew/repeat_note.ts";

export interface RepeatAlarm {
  readonly fired: boolean;
  readonly since?: string;
  readonly repo?: string;
  readonly number?: number;
  readonly says: string;
}

export function alarmRepeat(db: Database): RepeatAlarm {
  // Walks the repositories that run themselves, then their open issues by
  // `issue_repo_kind_state_number`, each one's newest comment by the thread's index.
  const r = db
    .query<{ repo: string; number: number; at: string }, [string]>(
      `SELECT o.username || '/' || r.name AS repo, i.number, c.created_at AS at
         FROM repo r CROSS JOIN issue i ON i.repo_id = r.id
         JOIN user o ON o.id = r.owner_id
         JOIN comment c ON c.id = (SELECT id FROM comment WHERE issue_id = i.id ORDER BY created_at DESC, id DESC LIMIT 1)
        WHERE r.autonomy != 'off' AND i.state = 'open' AND c.body = ?1
        ORDER BY c.created_at LIMIT 1`,
    )
    .get(REPEAT_NOTE);
  if (r === null) return { fired: false, says: "No issue is repeating runs." };
  return {
    fired: true,
    since: r.at,
    repo: r.repo,
    number: r.number,
    says: `${r.repo}#${r.number} ran more than three times in ten minutes and was stopped; it waits for a person to say what to try.`,
  };
}
