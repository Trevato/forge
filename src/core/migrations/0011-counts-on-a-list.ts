// 11 — counts on a list, and the index that keeps a search off a table
// scan. A repo row is useless without "how much is open here", and asking
// per row is the N+1 that turns fifty repos into a hundred queries; the
// grouped helpers in core/repos.ts and core/issues.ts answer instead.
//
// For a *cached* origin repo we cannot compute the number — the origin
// holds the conversations — so it is recorded as the origin states it,
// honestly. GitHub's `open_issues_count` is issues AND pull requests in
// one number and it will not separate them; Forgejo reports both. The
// flag says which we were handed, so no surface has to guess whether a
// number it is rendering means what it says.
export default `
  ALTER TABLE origin_repo ADD COLUMN open_issues INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE origin_repo ADD COLUMN open_pulls INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE origin_repo ADD COLUMN counts_include_pulls INTEGER NOT NULL DEFAULT 0;

  -- Search orders issues by recency inside a bounded set of repos. Without
  -- this the ORDER BY is a scan of every issue in the forge.
  CREATE INDEX issue_repo_updated ON issue(repo_id, updated_at);
  `;
