// `chapter` (#11603): a named list of a repository's issues that is finished, tagged and closed.
// At most one is open per repository (the partial unique index); any number are drafts that wait.
// `chapter_item` puts an issue in at most one chapter. A closed chapter keeps its tag, notes and
// figures forever. New tables and indexes only. Additive.
export default `
  CREATE TABLE chapter (
    id         TEXT PRIMARY KEY,
    repo_id    TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    means      TEXT NOT NULL DEFAULT '',
    state      TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','open','closed')),
    position   INTEGER NOT NULL DEFAULT 0,
    patch_of   TEXT REFERENCES chapter(id) ON DELETE SET NULL,
    created_by TEXT REFERENCES user(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    opened_at  TEXT,
    closed_at  TEXT,
    tag_oid    TEXT,
    notes      TEXT NOT NULL DEFAULT '',
    cost_usd   REAL,
    UNIQUE (repo_id, name)
  );
  CREATE UNIQUE INDEX chapter_one_open ON chapter(repo_id) WHERE state = 'open';
  CREATE INDEX chapter_repo ON chapter(repo_id, state, position);
  CREATE TABLE chapter_item (
    issue_id   TEXT PRIMARY KEY REFERENCES issue(id) ON DELETE CASCADE,
    chapter_id TEXT NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
    by_id      TEXT REFERENCES user(id) ON DELETE SET NULL,
    at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX chapter_item_chapter ON chapter_item(chapter_id);
  `;
