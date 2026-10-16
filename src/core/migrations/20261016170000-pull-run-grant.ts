// A writer's leave for one proposed pull's exact head to run. Kept apart
// from reviews so it never counts toward a required review.
export default `
  CREATE TABLE pull_run_grant (
    issue_id   TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    commit_oid TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    granted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (issue_id, commit_oid)
  );
  `;
