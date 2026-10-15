// 83 — releases (#1662): one row per landing on the forge's own repository
// that was checked out and preflighted (`release/`). `ok` is the preflight
// verdict, `line` its one line; the pull is kept as a number so the row
// outlives a deleted pull.
export default `
  CREATE TABLE release (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sha         TEXT NOT NULL,
    repo_id     TEXT NOT NULL,
    pull_number INTEGER,
    ok          INTEGER NOT NULL,
    line        TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX release_created ON release(created_at);
  `;
