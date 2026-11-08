// A rotating refresh token for an OAuth access token that expires (#8361).
// Only the hash is kept. `family` ties every rotation of one grant together
// so a spent token presented again can end them all (OAuth 2.1 §4.3.1).
// `token_id` is the access token the row last bought; it clears when that
// token goes. Additive; the table starts empty.
export default `
  CREATE TABLE oauth_refresh (
    token_hash  TEXT PRIMARY KEY,
    family      TEXT NOT NULL,
    token_id    TEXT REFERENCES token(id) ON DELETE SET NULL,
    client_id   TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    scope       TEXT NOT NULL,
    name        TEXT NOT NULL,
    lifetime_s  INTEGER NOT NULL,
    oidc_scopes TEXT NOT NULL DEFAULT '',
    spent       INTEGER NOT NULL DEFAULT 0,
    expires_at  TEXT NOT NULL
  );
  CREATE INDEX oauth_refresh_family ON oauth_refresh(family);
  CREATE INDEX oauth_refresh_token ON oauth_refresh(token_id);
  `;
