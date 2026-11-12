// `planner_pause` (#11604): one row per repository whose planner the owner paused, with the time
// it lifts itself (`9999-…` when it waits for the owner). An index for the growth panel's per-day reads.
// New table and indexes only. Additive.
export default `
  CREATE TABLE planner_pause (
    repo_id TEXT PRIMARY KEY REFERENCES repo(id) ON DELETE CASCADE,
    until   TEXT NOT NULL,
    by_id   TEXT REFERENCES user(id) ON DELETE SET NULL,
    at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX issue_repo_created ON issue(repo_id, created_at);
  `;
