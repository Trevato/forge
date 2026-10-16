/**
 * A setting the sentinel found away from its default is the owner's ask
 * (#2029), never a crew run. The finding is filed by a crew member, so the
 * autonomy clock would otherwise count it ready and hand it to a builder.
 */

import type { Database } from "bun:sqlite";

/** Whether this issue is the open finding of a `setting:<key>` the sentinel reported. */
export function isSettingFinding(db: Database, issueId: string): boolean {
  return (
    db
      .query<{ n: number }, [string]>(
        "SELECT 1 AS n FROM sentinel_finding WHERE issue_id = ?1 AND key LIKE 'setting:%'",
      )
      .get(issueId) !== null
  );
}
