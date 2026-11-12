// A reviewer's finding that repeated until a check was proposed for it (#8716):
// one row per finding, its words as the key, the issue that asks for the lint
// or test, and when that issue was done (retired). Two indexes let the weekly
// read walk the week's reviews and review line comments by time. Additive.
export default `
  CREATE TABLE IF NOT EXISTS review_finding (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    sample TEXT NOT NULL,
    seen INTEGER NOT NULL,
    issue_number INTEGER NOT NULL,
    proposed_at TEXT NOT NULL,
    retired_at TEXT
  );
  CREATE INDEX IF NOT EXISTS review_finding_repo ON review_finding (repo_id, proposed_at);
  CREATE INDEX IF NOT EXISTS review_created ON review (created_at);
  CREATE INDEX IF NOT EXISTS comment_kind_created ON comment (kind, created_at);
  `;
