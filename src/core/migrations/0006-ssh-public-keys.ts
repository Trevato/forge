// 6 — SSH public keys. A user may register keys that authenticate them on
// the SSH listener. The wire blob is stored as-is (base64); the OpenSSH
// SHA256 fingerprint is the lookup key and is unique across the forge, so a
// key identifies exactly one account.
export default `
  CREATE TABLE user_key (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    algo         TEXT NOT NULL,
    blob         TEXT NOT NULL,
    fingerprint  TEXT NOT NULL UNIQUE,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_used_at TEXT
  );
  CREATE INDEX user_key_user ON user_key(user_id);
  `;
