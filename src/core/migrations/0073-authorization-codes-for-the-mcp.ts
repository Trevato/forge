// 73 — authorization codes for the MCP's OAuth (#971): one per consent,
// kept by hash, spent by deleting. The code is never stored.
export default `
  CREATE TABLE IF NOT EXISTS oauth_code (
    code_hash     TEXT PRIMARY KEY,
    client_id     TEXT NOT NULL REFERENCES oauth_client(id) ON DELETE CASCADE,
    user_id       TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    redirect_uri  TEXT NOT NULL,
    challenge     TEXT NOT NULL,
    scope         TEXT NOT NULL CHECK (scope IN ('ro','rw')),
    name          TEXT NOT NULL,
    lifetime_s    INTEGER,
    expires_at    TEXT NOT NULL
  );
  `;
