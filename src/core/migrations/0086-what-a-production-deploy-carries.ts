// 86 — what a production deploy carries (pull #1753, issue #1600): one row per merged pull
// whose merge commit the deployed commit contains, written when the deploy
// finishes. An index over git, so no foreign key outlives a deleted run.
export default `
  CREATE TABLE deploy_pull (
    run_id      TEXT NOT NULL,
    issue_id    TEXT NOT NULL,
    pull_number INTEGER NOT NULL,
    merged_oid  TEXT NOT NULL,
    PRIMARY KEY (run_id, issue_id)
  );
  CREATE INDEX deploy_pull_issue ON deploy_pull(issue_id);
  `;
