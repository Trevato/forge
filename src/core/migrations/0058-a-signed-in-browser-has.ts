// 58 — a signed-in browser has a name and a last-seen time (#750), so its
// person (and the forge's owner) can list them and sign one out. The id
// is not the secret: the cookie's hash stays the key.
export default `
  ALTER TABLE session ADD COLUMN id TEXT;
  ALTER TABLE session ADD COLUMN last_seen_at TEXT;
  UPDATE session SET id = lower(hex(randomblob(12))) WHERE id IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS session_id ON session(id);
  `;
