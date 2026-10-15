// 67 — every fork a person made, kept when the fork is deleted (#888):
// the daily limit counts what was made, so deleting a copy does not make
// room for another. Nothing but the account's own deletion removes a row.
export default `
  CREATE TABLE IF NOT EXISTS fork_made (
    owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    made_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS fork_made_owner ON fork_made(owner_id, made_at);
  `;
