// Notes left from the forge button in an app: who sent each (an anonymous
// visitor key or a person), which issue it became, and whether the owner
// hid it; and the visitors an app's owner has banned. Additive.
export default `
  CREATE TABLE IF NOT EXISTS app_note (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL,
    repo_id TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    visitor TEXT NOT NULL,
    name TEXT NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS app_note_visitor ON app_note(app_id, visitor, created_at);
  CREATE TABLE IF NOT EXISTS app_note_ban (
    app_id TEXT NOT NULL,
    visitor TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (app_id, visitor)
  );
  `;
