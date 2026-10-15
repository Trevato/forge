// 53 — whether an account's email is proven, and its one-time link (#659).
// A row is written for every account a public way in makes, unproven; the
// accounts here before this migration are proven by it, so verification
// holds back newcomers, never the people already here.
export default `
  CREATE TABLE IF NOT EXISTS email_check (
    user_id      TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
    verified_at  TEXT,
    token_hash   TEXT UNIQUE,
    expires_at   TEXT,
    last_sent_at TEXT,
    sent_to      TEXT,
    sends_day    TEXT,
    sends        INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO email_check (user_id, verified_at)
    SELECT id, created_at FROM user;
  `;
