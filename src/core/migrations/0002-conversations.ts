// 2 — conversations: issues and (later) pulls share one table, one number
// sequence per repo, one comment stream, one label system.
export default `
  ALTER TABLE repo ADD COLUMN issue_seq INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE issue (
    id         TEXT PRIMARY KEY,
    repo_id    TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    number     INTEGER NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'issue' CHECK (kind IN ('issue','pull')),
    title      TEXT NOT NULL,
    body       TEXT NOT NULL DEFAULT '',
    author_id  TEXT NOT NULL REFERENCES user(id),
    state      TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    closed_at  TEXT,
    UNIQUE (repo_id, number)
  );
  CREATE INDEX issue_repo_state ON issue(repo_id, state, kind);

  CREATE TABLE comment (
    id         TEXT PRIMARY KEY,
    issue_id   TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    author_id  TEXT NOT NULL REFERENCES user(id),
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX comment_issue ON comment(issue_id, id);

  CREATE TABLE label (
    id      TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    name    TEXT NOT NULL,
    color   TEXT NOT NULL DEFAULT '6b7280',
    UNIQUE (repo_id, name COLLATE NOCASE)
  );

  CREATE TABLE issue_label (
    issue_id TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    label_id TEXT NOT NULL REFERENCES label(id) ON DELETE CASCADE,
    PRIMARY KEY (issue_id, label_id)
  );
  `;
