// The `telemetry:read` grant (#1789): which named agent may read /flow,
// /system and the boards' sources, who gave it, and every read it made.
export default `
  CREATE TABLE telemetry_grant (
    user_id    TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
    granted_by TEXT NOT NULL REFERENCES user(id),
    granted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE telemetry_read (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    what    TEXT NOT NULL,
    at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX telemetry_read_at ON telemetry_read(at);
  `;
