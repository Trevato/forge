// 5 — organizations and teams. An org is a user row with kind 'org' (so it
// owns repos through the same owner_id, no repo change). Teams belong to an
// org, carry a permission level, and have members; a user's access to an
// org's repos is the highest permission across the teams they're on.
export default `
  ALTER TABLE user ADD COLUMN kind TEXT NOT NULL DEFAULT 'user'
    CHECK (kind IN ('user','org'));

  CREATE TABLE team (
    id         TEXT PRIMARY KEY,
    org_id     TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    permission TEXT NOT NULL DEFAULT 'read' CHECK (permission IN ('read','write','admin')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (org_id, name COLLATE NOCASE)
  );

  CREATE TABLE team_member (
    team_id TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    PRIMARY KEY (team_id, user_id)
  );
  CREATE INDEX team_member_user ON team_member(user_id);
  `;
