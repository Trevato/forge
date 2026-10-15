// 55 — a hold on a pull (#773, `core/holds.ts`): a person who writes the
// repository says "not this one yet", and while it stands no rule sends
// the pull to review or lands it. A release is kept, not deleted: the
// review clock starts again from it. At most one hold stands per pull.
export default `
  CREATE TABLE IF NOT EXISTS pull_hold (
    id          TEXT PRIMARY KEY,
    issue_id    TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    held_by     TEXT NOT NULL REFERENCES user(id),
    why         TEXT NOT NULL,
    held_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    released_by TEXT REFERENCES user(id),
    released_at TEXT
  );
  CREATE INDEX IF NOT EXISTS pull_hold_issue ON pull_hold(issue_id, released_at);
  CREATE UNIQUE INDEX IF NOT EXISTS pull_hold_standing
    ON pull_hold(issue_id) WHERE released_at IS NULL;
  `;
