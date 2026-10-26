// The record of a followed upstream's checks (#5979): one row per check, the
// last 20 kept per repository by `noteCheck`. `outcome` is merged, uptodate,
// conflict or error; `detail` is the conflict's file count or the error's
// first line. A new table, so a repository with no rows shows only its row.
export default `
  CREATE TABLE IF NOT EXISTS repo_upstream_check (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    behind INTEGER NOT NULL DEFAULT 0,
    outcome TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS repo_upstream_check_repo ON repo_upstream_check (repo_id, id);
  `;
