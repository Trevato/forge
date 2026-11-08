// What the dependency radar last read about one package a repository pins
// (#9434): the newest version upstream and when it was read. One row per
// repository and package.
// New table only. Additive.
export default `
  CREATE TABLE dep_latest (
    repo_id    TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    latest     TEXT NOT NULL,
    error      TEXT NOT NULL DEFAULT '',
    checked_at TEXT NOT NULL,
    PRIMARY KEY (repo_id, name)
  );
  `;
