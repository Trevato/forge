// What lets a guest help build a public repository safely: which forks are a
// guest's contribution (`core/contribute.ts`), the pulls a guest sent, and the
// accounts each address made. Deleting a repository takes its marker with it;
// the two ledgers are pruned as they are written. New tables only. Additive.
export default `
  CREATE TABLE contribution_fork (
    repo_id TEXT PRIMARY KEY REFERENCES repo(id) ON DELETE CASCADE,
    made_at TEXT NOT NULL
  );
  CREATE INDEX contribution_fork_made ON contribution_fork(made_at);
  CREATE TABLE guest_pull_made (
    owner_id TEXT NOT NULL,
    made_at INTEGER NOT NULL
  );
  CREATE INDEX guest_pull_made_owner ON guest_pull_made(owner_id, made_at);
  CREATE TABLE signup_made (
    source TEXT NOT NULL,
    made_at INTEGER NOT NULL
  );
  CREATE INDEX signup_made_source ON signup_made(source, made_at);
  CREATE INDEX signup_made_at ON signup_made(made_at);
  `;
