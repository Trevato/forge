// A repository's closed pulls in a time window, found by index (#8103): the
// crew's per-tick "closed today" count no longer reads the repo's newest
// rows to filter them in JS. Partial, so it serves only that kind and no
// other event lookup is steered onto it. Additive.
export default `
  CREATE INDEX IF NOT EXISTS event_repo_pull_closed_at ON event(repo_id, created_at) WHERE kind = 'pull.closed';
  `;
