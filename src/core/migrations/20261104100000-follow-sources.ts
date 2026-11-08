// A repository follows any number of sources (#9003): each its own address and
// branch, with its own reading. `account` is the trusted account the source's
// work is stamped as, when a forge admin named it (else the address's owner).
// `source_conflict` ties a conflict issue to the source whose head it is
// about, so the crew's resolving pull carries that source. `pull_source.big`
// marks a first fold too large to land on a check alone: the crew reviews it.
// Additive.
export default `
  CREATE TABLE repo_source (
    id         TEXT PRIMARY KEY,
    repo_id    TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    url        TEXT NOT NULL,
    branch     TEXT NOT NULL,
    origin_id  TEXT NOT NULL DEFAULT '',
    account    TEXT NOT NULL DEFAULT '',
    by_id      TEXT NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    checked_at TEXT,
    tip        TEXT NOT NULL DEFAULT '',
    behind     INTEGER NOT NULL DEFAULT 0,
    error      TEXT NOT NULL DEFAULT '',
    pending_id TEXT,
    opened     INTEGER NOT NULL DEFAULT 0,
    UNIQUE (repo_id, url, branch)
  );
  CREATE TABLE source_conflict (
    issue_id  TEXT PRIMARY KEY REFERENCES issue(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL,
    host      TEXT NOT NULL,
    account   TEXT NOT NULL,
    via       TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX source_conflict_by_source ON source_conflict (source_id);
  ALTER TABLE pull_source ADD COLUMN big INTEGER NOT NULL DEFAULT 0;
  `;
