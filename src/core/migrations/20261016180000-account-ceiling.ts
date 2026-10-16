// Each account has its own daily and per-run model spend ceiling (#897),
// apart from the forge-wide one. A row only when an admin set one;
// no row means no ceiling, and clearing one deletes the row.
export default `
  CREATE TABLE account_ceiling (
    user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
    daily_usd REAL NOT NULL CHECK (daily_usd > 0),
    per_run_usd REAL NOT NULL CHECK (per_run_usd > 0),
    set_by TEXT,
    set_at TEXT NOT NULL
  ) WITHOUT ROWID;
  `;
