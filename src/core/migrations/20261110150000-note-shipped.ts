// The forge's own "this note shipped" comment is marked, so a second landing
// finds it by what the forge stored, never by what the comment says (#10564).
// One row per issue; the pull is kept so the release can be named later. Additive.
export default `
  CREATE TABLE note_shipped (
    issue_id    TEXT PRIMARY KEY REFERENCES issue(id) ON DELETE CASCADE,
    comment_id  TEXT NOT NULL REFERENCES comment(id) ON DELETE CASCADE,
    pull_number INTEGER NOT NULL
  );
  CREATE INDEX note_shipped_pull ON note_shipped (pull_number);
  `;
