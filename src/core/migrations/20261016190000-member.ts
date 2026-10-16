// An account is a guest, a member or an admin (#2301). Admin is `user.is_admin`;
// a member is a row here; everyone else is a guest.
export default `
  CREATE TABLE member (
    user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
    promoted_by TEXT,
    promoted_at TEXT NOT NULL
  ) WITHOUT ROWID;
  `;
