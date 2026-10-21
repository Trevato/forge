// A repository follows an outside upstream (#3442): the https or http URL and
// branch it takes new commits from, whether it is on, who it acts as, the
// origin whose credential opens a private one, and what the last check read.
// `checking` is the claim one check holds while it runs. Additive.
export default `
  CREATE TABLE IF NOT EXISTS repo_upstream (
    repo_id TEXT PRIMARY KEY REFERENCES repo(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    branch TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    by_id TEXT NOT NULL,
    origin_id TEXT NOT NULL DEFAULT '',
    parent_url TEXT NOT NULL DEFAULT '',
    checked_at TEXT,
    tip TEXT NOT NULL DEFAULT '',
    behind INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '',
    pending_id TEXT,
    opened INTEGER NOT NULL DEFAULT 0,
    checking TEXT,
    updated_at TEXT NOT NULL
  );
  `;
