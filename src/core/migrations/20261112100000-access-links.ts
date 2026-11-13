// An admin's one-time access link for a person (`access_link`, #11688): only its hash is kept, with who
// made it, when it lapses and when it was spent. `account_notice` holds what a person is told the next
// time they are here ("an admin reset your access on …"); `seen_at` is set once it has been shown.
// `session.address` is where a browser was first seen from, for the admin's list of recent sign-ins.
// New tables and one nullable column. Additive.
export default `
  CREATE TABLE access_link (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    token_hash  TEXT NOT NULL UNIQUE,
    created_by  TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    used_at     TEXT
  );
  CREATE INDEX access_link_user ON access_link (user_id);
  CREATE TABLE account_notice (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id  TEXT NOT NULL,
    text     TEXT NOT NULL,
    at       TEXT NOT NULL,
    seen_at  TEXT
  );
  CREATE INDEX account_notice_unseen ON account_notice (user_id) WHERE seen_at IS NULL;
  ALTER TABLE session ADD COLUMN address TEXT;
  `;
