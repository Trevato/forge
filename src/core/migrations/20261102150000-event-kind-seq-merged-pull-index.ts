// An event of one kind, newest first, walked the repository's whole event
// history by `seq` dropping the other kinds (or sorted every event of the
// kind); `event_repo_kind_seq` and `event_kind_seq` hand them back already in
// order (#8061). The window of merged pulls uses the existing `pull_merged`.
// Additive.
export default `
  CREATE INDEX IF NOT EXISTS event_repo_kind_seq ON event(repo_id, kind, seq);
  CREATE INDEX IF NOT EXISTS event_kind_seq ON event(kind, seq);
  `;
