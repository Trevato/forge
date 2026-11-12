// An agent that came with only the forge's URL (#10912): one row per account the
// start call made, holding the hash of its one-time claim link, where it came
// from (a hashed source, for the per-hour cap) and where it is in its life:
// asleep after 7 days unclaimed, archived after 30, claimed by a person.
// Additive.
export default `
  CREATE TABLE start_account (
    user_id    TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
    claim_hash TEXT NOT NULL UNIQUE,
    source     TEXT NOT NULL,
    created_at TEXT NOT NULL,
    slept_at   TEXT,
    archived_at TEXT,
    claimed_at TEXT,
    claimed_by TEXT
  ) WITHOUT ROWID;
  CREATE INDEX start_account_created ON start_account (created_at);
  CREATE INDEX start_account_source ON start_account (source, created_at);
  `;
