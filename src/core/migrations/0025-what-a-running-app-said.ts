// 25 — what a running app said when the forge knocked on its doors and
// compared with its contract: one row per probe, kept, so the audit can
// show the last word and what changed.
export default `
  CREATE TABLE probe (
    id         TEXT PRIMARY KEY,
    app_id     TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
    commit_oid TEXT NOT NULL,
    verdict    TEXT NOT NULL CHECK (verdict IN ('ok','mismatch','unprobed','down')),
    said       TEXT NOT NULL,
    knocks     TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX probe_app ON probe (app_id, created_at);
  `;
