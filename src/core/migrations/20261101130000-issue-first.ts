// A person's "this first" (#7806): a writer put an open, ready issue ahead of
// the rest. One row per issue; it is deleted when the issue closes.
export default `
  CREATE TABLE IF NOT EXISTS issue_first (
    issue_id TEXT PRIMARY KEY REFERENCES issue(id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL,
    at       TEXT NOT NULL
  );
  `;
