// Gift codes (#11157): a code gives a plan to the forge made with it. Stored
// hashed; the plain code is shown once to the admin. Additive. `gift_try`
// counts a client's attempts so codes cannot be guessed by trying.
export default `
  CREATE TABLE gift_code (
    id TEXT PRIMARY KEY,
    hash TEXT NOT NULL UNIQUE,
    plan TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    uses INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT,
    revoked_at TEXT,
    made_by TEXT NOT NULL,
    made_at TEXT NOT NULL
  );
  CREATE TABLE gift_redeem (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code_id TEXT NOT NULL,
    forge TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX gift_redeem_code ON gift_redeem (code_id, id);
  CREATE TABLE gift_try (
    bucket TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX gift_try_bucket ON gift_try (bucket, at);
  `;
