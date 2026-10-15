// 59 — every message the forge sent, by a keyed hash of its recipient (#784): the
// per-recipient and forge-wide mail caps count it, across restarts.
export default `
  CREATE TABLE IF NOT EXISTS mail_sent (
    id        TEXT PRIMARY KEY,
    recipient TEXT NOT NULL,
    at        TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS mail_sent_recipient ON mail_sent(recipient, at);
  CREATE INDEX IF NOT EXISTS mail_sent_at ON mail_sent(at);
  `;
