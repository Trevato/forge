// 54 — the people a private app names (#752): they may enter it, its
// previews and nothing else — no write, no crew, no settings.
export default `
  CREATE TABLE IF NOT EXISTS app_member (
    app_id   TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
    user_id  TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    added_by TEXT REFERENCES user(id) ON DELETE SET NULL,
    added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (app_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS app_member_user ON app_member(user_id);
  `;
