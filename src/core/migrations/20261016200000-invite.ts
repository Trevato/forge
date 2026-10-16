// A single-use, expiring invite link (#2335). Only the hash of the token is stored.
export default `
  CREATE TABLE invite (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    used_at TEXT,
    used_by TEXT
  ) WITHOUT ROWID;
  `;
