// What a child forge has proposed to the forge above it: the branch it
// pushed there, the pull that opened, and the last state read back from the
// parent, with when. The parent is the truth; this is the child's cache of it.
export default `
  CREATE TABLE upstream_proposal (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id     TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    branch      TEXT NOT NULL,
    number      INTEGER NOT NULL,
    title       TEXT NOT NULL,
    source      TEXT NOT NULL,
    state       TEXT NOT NULL DEFAULT 'open',
    reachable   INTEGER NOT NULL DEFAULT 1,
    checked_at  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    UNIQUE (repo_id, branch)
  );
`;
