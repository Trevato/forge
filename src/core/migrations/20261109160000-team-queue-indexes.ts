// A team's page lists the open pulls waiting on its review, oldest first
// (#10162): open pulls are walked in age order from a partial index of just
// them, no sort and no table scan. Idempotent. Additive.
export default `
  CREATE INDEX IF NOT EXISTS issue_open_pull_age ON issue(created_at, id) WHERE state = 'open' AND kind = 'pull';
  `;
