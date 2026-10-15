// 63 — the forge's capacity, set live by an admin (#874): crew and check
// concurrency, shards per check, egress mode. The environment stays the
// boot default; a row here overrides it, and every change is kept.
export default `
  CREATE TABLE IF NOT EXISTS forge_setting (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS forge_setting_change (
    key        TEXT NOT NULL,
    from_value TEXT NOT NULL,
    to_value   TEXT NOT NULL,
    actor_id   TEXT NOT NULL,
    at         TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS forge_setting_change_at ON forge_setting_change(at);
  `;
