// 4 — forks: a repo may descend from another. The git objects are shared via
// alternates (instant, storage-bounded); the parent link records lineage and
// gates the detach-before-delete path. A pull's head may live in another repo
// (a fork), so it carries an explicit head_repo_id.
export default `
  ALTER TABLE repo ADD COLUMN fork_parent_id TEXT REFERENCES repo(id);
  CREATE INDEX repo_fork_parent ON repo(fork_parent_id);

  ALTER TABLE pull ADD COLUMN head_repo_id TEXT REFERENCES repo(id);
  `;
