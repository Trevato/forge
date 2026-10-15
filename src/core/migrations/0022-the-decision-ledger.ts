// 22 — the decision ledger: every fixed-choice decision the crew's
// decider made, with what it saw, what it answered, and what came of it.
export default `
  CREATE TABLE decision (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    repo_id    TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    issue_id   TEXT REFERENCES issue(id) ON DELETE SET NULL,
    state      TEXT NOT NULL,
    answer     TEXT NOT NULL,
    p          REAL NOT NULL,
    by         TEXT NOT NULL,
    ms         INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    outcome    TEXT,
    outcome_at TEXT
  );
  CREATE INDEX decision_issue ON decision(issue_id, kind, created_at);
  CREATE INDEX decision_repo ON decision(repo_id, created_at);
  `;
