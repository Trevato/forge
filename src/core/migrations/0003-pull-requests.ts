// 3 — pull requests: a 1:1 extension of an issue row, plus review-comment
// anchoring that survives a force-push (path/line + the line's content hash).
export default `
  CREATE TABLE pull (
    issue_id     TEXT PRIMARY KEY REFERENCES issue(id) ON DELETE CASCADE,
    base_branch  TEXT NOT NULL,
    head_branch  TEXT NOT NULL,
    base_oid     TEXT NOT NULL,
    head_oid     TEXT NOT NULL,
    merged_at    TEXT,
    merged_oid   TEXT,
    merged_by    TEXT REFERENCES user(id)
  );

  ALTER TABLE comment ADD COLUMN kind TEXT NOT NULL DEFAULT 'comment'
    CHECK (kind IN ('comment','review'));
  ALTER TABLE comment ADD COLUMN path TEXT;
  ALTER TABLE comment ADD COLUMN line INTEGER;
  ALTER TABLE comment ADD COLUMN side TEXT CHECK (side IN ('old','new'));
  ALTER TABLE comment ADD COLUMN commit_oid TEXT;
  ALTER TABLE comment ADD COLUMN line_hash TEXT;
  ALTER TABLE comment ADD COLUMN outdated INTEGER NOT NULL DEFAULT 0;
  `;
