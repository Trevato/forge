// 82 — passkeys (#1694): several per account. `credential_id` is the
// base64url id the authenticator names itself by; `key` is the public JWK,
// `sign_count` the last counter seen (a clone shows as one that stalls).
export default `
  CREATE TABLE passkey (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    credential_id TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    alg           TEXT NOT NULL,
    key           TEXT NOT NULL,
    sign_count    INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_used_at  TEXT
  );
  CREATE INDEX passkey_user ON passkey(user_id);
  `;
