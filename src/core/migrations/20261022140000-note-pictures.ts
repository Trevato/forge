// The picture a sender chose to send with a note from the forge button
// (#4820): which note it belongs to, its kind and size. The bytes are a file
// under the data directory. Additive.
export default `
  CREATE TABLE IF NOT EXISTS app_note_picture (
    note_id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    kind TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS app_note_picture_issue ON app_note_picture(repo_id, issue_number);
  `;
