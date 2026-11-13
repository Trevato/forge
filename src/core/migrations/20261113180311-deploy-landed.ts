// When each merged pull first went live (#12009, part of #11973): one row per pull, written by
// the first successful production deploy whose commit contains it, with that deploy's run and
// the instant it went live. It replaces reading `deploy_pull`, which holds one row per pull per
// deploy (2,500 rows for each of ~650 deploys a week on the forge's own repository: 9.9M rows,
// 2.2 GB on production). Nothing writes `deploy_pull` once this release is serving; the old
// table is trimmed in slices and dropped in a later release. An index over git, so no foreign key
// outlives a deleted run or pull. Additive: a table and nothing else; the release before keeps
// reading and writing `deploy_pull`.
export default `
  CREATE TABLE IF NOT EXISTS deploy_landed (
    issue_id    TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL,
    pull_number INTEGER NOT NULL,
    at          TEXT NOT NULL
  ) WITHOUT ROWID;
`;
