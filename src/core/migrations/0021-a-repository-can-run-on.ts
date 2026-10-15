// 21 — a repository can run on its own: how much, on what direction, with
// what ceiling; and each crew member has a role in it.
export default `
  ALTER TABLE repo ADD COLUMN autonomy TEXT NOT NULL DEFAULT 'off';
  ALTER TABLE repo ADD COLUMN autonomy_direction TEXT NOT NULL DEFAULT '';
  ALTER TABLE repo ADD COLUMN autonomy_ceiling_usd REAL NOT NULL DEFAULT 20;
  ALTER TABLE repo ADD COLUMN autonomy_slots INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE repo ADD COLUMN autonomy_by TEXT REFERENCES user(id);
  ALTER TABLE repo ADD COLUMN direction_issue_id TEXT REFERENCES issue(id) ON DELETE SET NULL;
  ALTER TABLE repo_crew ADD COLUMN role TEXT NOT NULL DEFAULT 'builder';
  `;
