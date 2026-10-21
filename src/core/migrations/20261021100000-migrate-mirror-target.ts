// Where a migrated repository keeps pushing after the move (#3408): the
// person chose to leave the source as a read-only mirror. One row per
// repository, with the tips last pushed (the lease for the next push); the credential stays on the origin, never here. Additive.
export default `
  CREATE TABLE migrate_mirror (
    repo_id    TEXT PRIMARY KEY REFERENCES repo(id) ON DELETE CASCADE,
    origin_id  TEXT NOT NULL REFERENCES origin(id) ON DELETE CASCADE,
    full_name  TEXT NOT NULL,
    clone_url  TEXT NOT NULL,
    tips       TEXT NOT NULL DEFAULT '{}',
    pushed_at  TEXT,
    last_error TEXT NOT NULL DEFAULT ''
  );
  `;
