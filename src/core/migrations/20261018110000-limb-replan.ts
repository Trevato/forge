// A person hands a limb to the planner to re-plan as fewer, larger pieces
// (#761): one row for the hand-over, one for each open issue it was given.
export default `
  CREATE TABLE limb_replan (
    id            TEXT PRIMARY KEY,
    repo_id       TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    limb_issue_id TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    by_user       TEXT NOT NULL,
    at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    taken_back_at TEXT
  );
  CREATE INDEX limb_replan_repo ON limb_replan(repo_id, at);
  CREATE TABLE limb_replan_issue (
    replan_id TEXT NOT NULL REFERENCES limb_replan(id) ON DELETE CASCADE,
    issue_id  TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    PRIMARY KEY (replan_id, issue_id)
  );
  `;
