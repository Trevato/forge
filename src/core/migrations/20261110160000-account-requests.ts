// A stranger asks for an account and waits (#10928). `user.waiting_at` is set
// while the account may not act (every credential asks `isActive`); the
// request keeps the note, where it came from and the admin's answer. A forge
// that stored `closed` stays closed: this changes no stored setting.
export default `
  ALTER TABLE user ADD COLUMN waiting_at TEXT;
  CREATE TABLE account_request (
    user_id    TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
    note       TEXT NOT NULL DEFAULT '',
    source     TEXT NOT NULL DEFAULT '',
    state      TEXT NOT NULL CHECK (state IN ('waiting', 'allowed', 'declined')),
    asked_at   TEXT NOT NULL,
    decided_at TEXT,
    decided_by TEXT,
    told_at    TEXT
  );
  CREATE INDEX account_request_state ON account_request(state, asked_at);
  `;
