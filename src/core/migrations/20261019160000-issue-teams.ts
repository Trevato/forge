// Cross-team work (#2681): an issue may name up to two crew teams; the pull
// that closes it is reviewed by each. Additive: a new table, nothing altered.
export default `
  CREATE TABLE issue_team (
    issue_id  TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    team_slug TEXT NOT NULL REFERENCES crew_team(slug) ON DELETE CASCADE,
    PRIMARY KEY (issue_id, team_slug)
  );
  `;
