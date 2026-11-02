// A repository's events of one kind in a time window, found by index (#8103):
// the crew's per-tick "closed today" count no longer reads the repo's newest
// rows to filter them in JS. Additive.
export default `
  CREATE INDEX IF NOT EXISTS event_repo_kind_at ON event(repo_id, kind, created_at);
  `;
