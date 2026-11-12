// The home and a repository page read the whole issue table cold (#7896):
// the open counts of every repository, the open pulls, the newest comment of
// every open issue. Each now walks an index and not the table: the counts
// are answered by `issue_counts` alone, open pulls by a partial index of
// just them, a time window of pulls by `issue_created`, and an issue's
// newest comment by its place in `comment_issue_at`. Additive.
export default `
  CREATE INDEX issue_counts ON issue(repo_id, state, sealed, kind);
  CREATE INDEX issue_open_pull ON issue(repo_id) WHERE state = 'open' AND kind = 'pull';
  CREATE INDEX issue_created ON issue(created_at);
  CREATE INDEX comment_issue_at ON comment(issue_id, created_at, id);
  `;
