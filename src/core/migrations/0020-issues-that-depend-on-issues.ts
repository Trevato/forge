// 20 — issues that depend on issues: one row per edge, the plan itself.
export default `
  CREATE TABLE issue_dependency (
    issue_id      TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    blocked_by_id TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    actor_id      TEXT REFERENCES user(id),
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (issue_id, blocked_by_id)
  );
  CREATE INDEX issue_dependency_blocker ON issue_dependency(blocked_by_id);
  `;
