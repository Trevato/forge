// One row per test a default-branch check saw fail and then pass when run
// alone (#6643, checks/flake.ts): the commit, the run, the test and its file.
// The flake list is a count of these over a week. Additive.
export default `
  CREATE TABLE check_flake (
    id         TEXT PRIMARY KEY,
    repo_id    TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    run_id     TEXT NOT NULL,
    commit_oid TEXT NOT NULL DEFAULT '',
    test       TEXT NOT NULL,
    file       TEXT NOT NULL,
    at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX check_flake_test ON check_flake(repo_id, test, at);
  `;
