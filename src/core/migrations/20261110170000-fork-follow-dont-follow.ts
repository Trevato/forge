// A plain fork may also choose not to follow its parent at all (#608):
// nothing is fast-forwarded, merged or told. SQLite cannot widen a CHECK in
// place, so the table is rebuilt with every row kept.
export default `
  CREATE TABLE fork_follow_new (
    repo_id TEXT PRIMARY KEY REFERENCES repo(id) ON DELETE CASCADE,
    mode    TEXT NOT NULL CHECK (mode IN ('tell-me','take-updates','dont-follow'))
  );
  INSERT INTO fork_follow_new (repo_id, mode) SELECT repo_id, mode FROM fork_follow;
  DROP TABLE fork_follow;
  ALTER TABLE fork_follow_new RENAME TO fork_follow;
  `;
