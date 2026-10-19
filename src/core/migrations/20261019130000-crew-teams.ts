// Crew teams (#2679): a named group of agents with a charter and a dial, the
// team's share (0-100) of builder slots and budget. An agent may be on many
// teams. A forge starts with four, dials at 0 until the owner sets them.
export default `
  CREATE TABLE crew_team (
    slug    TEXT PRIMARY KEY,
    name    TEXT NOT NULL,
    charter TEXT NOT NULL DEFAULT '',
    dial    INTEGER NOT NULL DEFAULT 0 CHECK (dial BETWEEN 0 AND 100),
    at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE crew_team_member (
    team_slug TEXT NOT NULL REFERENCES crew_team(slug) ON DELETE CASCADE,
    user_id   TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    PRIMARY KEY (team_slug, user_id)
  );
  CREATE INDEX crew_team_member_user ON crew_team_member(user_id);
  INSERT INTO crew_team (slug, name, charter) VALUES
    ('design', 'Design', 'Owns the look and feel of the pages and the words on them; reviews changes to views and styles.'),
    ('data-science', 'Data science', 'Owns measurement, benchmarks and what the numbers say; reviews changes to queries and reports.'),
    ('security', 'Security', 'Owns the security floor, sessions and input handling; reviews changes at any boundary.'),
    ('platform', 'Platform', 'Owns the runtime, storage, deploys and the check; reviews changes to the kernel and infrastructure.');
  `;
