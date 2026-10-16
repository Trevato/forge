// A new account has a model budget of zero (#1145). A forge admin may give one
// a capped grant, in dollars per month, spent on the forge's own credential.
export default `
  CREATE TABLE model_grant (
    user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
    usd_per_month REAL NOT NULL CHECK (usd_per_month > 0),
    granted_by TEXT,
    granted_at TEXT NOT NULL
  ) WITHOUT ROWID;
  `;
