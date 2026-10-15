// 66 — a milestone a person watches (#732, `core/watches.ts`): one row per
// person and issue. Its progress is read from the plan, never stored.
export default `
  CREATE TABLE IF NOT EXISTS milestone_watch (
    user_id    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    issue_id   TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (user_id, issue_id)
  );
  CREATE INDEX IF NOT EXISTS milestone_watch_issue ON milestone_watch(issue_id);
  `;
