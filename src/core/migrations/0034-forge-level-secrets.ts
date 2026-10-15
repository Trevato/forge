// 34 — forge-level secrets: credentials the forge itself needs, sealed
// under AAD `secret:<scope>:<name>` and never read back. `scope_id` is ''
// for the forge, an org's or a repo's id otherwise.
export default `
  CREATE TABLE secret (
    name         TEXT NOT NULL,
    scope        TEXT NOT NULL CHECK (scope IN ('forge','org','repo')),
    scope_id     TEXT NOT NULL DEFAULT '',
    value_enc    TEXT NOT NULL,
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_read_at TEXT,
    PRIMARY KEY (name, scope, scope_id)
  );
  `;
