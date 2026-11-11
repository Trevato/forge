// The issues naming a team are read by team (#10162): the table's key leads
// with the issue, so a team's lookup gets its own index. Idempotent. Additive.
export default `
  CREATE INDEX IF NOT EXISTS issue_team_slug ON issue_team(team_slug, issue_id);
  `;
